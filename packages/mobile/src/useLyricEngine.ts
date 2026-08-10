/**
 * Ties together detection (SourceArbiter), lyric lookup (@lyric-viewer/core),
 * and the Reanimated shared values that drive Starfield.tsx + LyricColumn.tsx.
 * The Phase 2 counterpart to the wiring at the bottom of
 * src/renderer/renderer.js (the window.player.onTrack/onTick/... handlers)
 * plus its frame() loop's line-change/drop/build-up detection.
 *
 * Design note: cue-boundary detection (which line is active, whether a drop
 * just fired) runs on the JS thread via requestAnimationFrame, same tier of
 * performance as the original Electron app's rAF loop — it only needs to run
 * once per lyric line change (a few times a minute), not once per animation
 * frame, so there's no benefit to pushing it onto the UI thread. Only the
 * continuously-animating backdrop math (Starfield.tsx) needs UI-thread
 * worklets. See Starfield.tsx's header for why its colour math is duplicated
 * there rather than imported from core.
 *
 * NOT run/tested — see Starfield.tsx's header for the same caveat.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrameCallback, useSharedValue, useDerivedValue } from 'react-native-reanimated';
import {
  fetchSyncedLyrics,
  findCueIndex,
  lineEnergy,
  paletteForTrack,
  type LyricCue,
} from '@lyric-viewer/core';
import { AppleMusicSource } from './sources/AppleMusicSource';
import { MockSource } from './sources/MockSource';
import { SourceArbiter, type ArbitratedTrack } from './sources/SourceArbiter';

const GAP_DROP_MS = 5000; // a lyric arriving after this much silence = a "drop"
const BUILDUP_WINDOW_MS = 3500; // ramp starts this long before the drop lands

export function useLyricEngine() {
  const [track, setTrack] = useState<ArbitratedTrack | null>(null);
  const [cues, setCues] = useState<LyricCue[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [statusText, setStatusText] = useState('waiting for playback…');
  const [palette, setPalette] = useState<[string, string, string, string]>([
    '#0d0d1a',
    '#4361ee',
    '#7209b7',
    '#4cc9f0',
  ]);
  const [backdropLevel] = useState(2); // 0-3: ghost/tinted/vivid/solid; persistence is a small future addition

  const cuesRef = useRef<LyricCue[]>([]);
  const activeIndexRef = useRef(-1);
  const lookupToken = useRef(0);

  // --- UI-thread clock + position estimate ---------------------------------

  const now = useSharedValue(Date.now());
  useFrameCallback((frameInfo) => {
    'worklet';
    now.value = frameInfo.timestamp;
  });

  const posAnchorMs = useSharedValue(0);
  const posAnchorAt = useSharedValue(Date.now());
  const playing = useSharedValue(false);

  const positionMs = useDerivedValue(() => {
    'worklet';
    if (!playing.value) return posAnchorMs.value;
    return posAnchorMs.value + (now.value - posAnchorAt.value);
  }, [now, playing, posAnchorMs, posAnchorAt]);

  // --- backdrop event shared values -----------------------------------------

  const lineStartAt = useSharedValue(0);
  const lineEnergyValue = useSharedValue(0);
  const buildupStartAt = useSharedValue(0);
  const buildupEndAt = useSharedValue(0);
  const dropAt = useSharedValue(0);
  const baseEnergy = useSharedValue(0.5);

  // --- detection + lyric lookup ---------------------------------------------

  useEffect(() => {
    // MockSource is listed last and only reports available when the native
    // Apple Music bridge is absent (e.g. Expo Go), so the real Apple Music
    // source always wins in a proper dev-client / production build.
    const arbiter = new SourceArbiter(
      [new AppleMusicSource(), new MockSource()],
      {
      onTrack: async (t) => {
        setTrack(t);
        setCues([]);
        cuesRef.current = [];
        setActiveIndex(-1);
        activeIndexRef.current = -1;
        setStatusText('finding lyrics…');
        lineStartAt.value = 0;
        dropAt.value = 0;
        buildupStartAt.value = 0;
        buildupEndAt.value = 0;

        const hashPalette = paletteForTrack(t);
        setPalette(hashPalette.palette);
        baseEnergy.value = hashPalette.energy;
        // Sentiment-driven palette upgrade (mood analysis → richer palette +
        // baseEnergy) is Phase 3 territory alongside on-device translation —
        // not wired up yet, so every track uses the instant hash palette.

        const token = ++lookupToken.current;
        try {
          const result = await fetchSyncedLyrics(t);
          if (token !== lookupToken.current) return;
          if (!result) {
            setStatusText('no synced lyrics found');
            return;
          }
          setCues(result.cues);
          cuesRef.current = result.cues;
          setStatusText('');
        } catch (err) {
          if (token !== lookupToken.current) return;
          setStatusText(`lyric lookup failed: ${(err as Error).message}`);
        }
      },
      onTick: (tick) => {
        posAnchorMs.value = tick.positionMs;
        posAnchorAt.value = Date.now();
        playing.value = tick.status === 'Playing';
      },
      onIdle: () => {
        setTrack(null);
        setCues([]);
        cuesRef.current = [];
        setActiveIndex(-1);
        activeIndexRef.current = -1;
        setStatusText('nothing playing');
        lineStartAt.value = 0;
        dropAt.value = 0;
        buildupStartAt.value = 0;
        buildupEndAt.value = 0;
      },
    });

    arbiter.start();
    return () => arbiter.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- line-boundary detection (JS thread, ~60fps, same tier as the original) --

  useEffect(() => {
    let raf: number;
    const tick = () => {
      const cuesNow = cuesRef.current;
      if (cuesNow.length > 0) {
        const newIndex = findCueIndex(cuesNow, positionMs.value);
        if (newIndex !== activeIndexRef.current) {
          const prevIndex = activeIndexRef.current;

          // A lyric arriving after a long instrumental gap is a "drop" — but
          // only on a natural one-line advance, not a seek/jump or the
          // lyrics-just-finished-loading case.
          if (newIndex === prevIndex + 1 && newIndex > 0) {
            const gap = cuesNow[newIndex].timeMs - cuesNow[newIndex - 1].timeMs;
            if (gap > GAP_DROP_MS) dropAt.value = Date.now();
          }

          lineStartAt.value = newIndex >= 0 ? Date.now() : 0;
          lineEnergyValue.value = newIndex >= 0 ? lineEnergy(cuesNow, newIndex) : 0;

          // Recompute the build-up window toward whatever line comes next.
          const gapStartMs = newIndex >= 0 ? cuesNow[newIndex].timeMs : 0;
          const nextCue = cuesNow[newIndex + 1];
          if (nextCue && nextCue.timeMs - gapStartMs > GAP_DROP_MS) {
            const wallNow = Date.now();
            const posNow = positionMs.value;
            buildupStartAt.value = wallNow + (nextCue.timeMs - BUILDUP_WINDOW_MS - posNow);
            buildupEndAt.value = wallNow + (nextCue.timeMs - posNow);
          } else {
            buildupStartAt.value = 0;
            buildupEndAt.value = 0;
          }

          activeIndexRef.current = newIndex;
          setActiveIndex(newIndex);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const starfieldValues = useMemo(
    () => ({ now, lineStartAt, lineEnergyValue, buildupStartAt, buildupEndAt, dropAt, baseEnergy }),
    [now, lineStartAt, lineEnergyValue, buildupStartAt, buildupEndAt, dropAt, baseEnergy]
  );

  return {
    track,
    cues,
    translationCues: null as LyricCue[] | null, // Phase 3: on-device translation
    showTranslation: true,
    activeIndex,
    statusText,
    palette,
    backdropLevel,
    positionMs,
    starfieldValues,
  };
}
