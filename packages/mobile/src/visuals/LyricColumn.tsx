/**
 * Apple-Music-style scrolling lyric column: active line centered, others
 * fade by distance, scroll speed adapts to lyric cadence, and the active
 * line's words highlight in place as playback passes them. The Phase 2
 * counterpart to the column logic in src/renderer/renderer.js
 * (buildColumn/setActive/renderWords/paintWords).
 *
 * Simplifications vs. the original (documented, not accidental — see
 * packages/mobile/README.md):
 *   - Word highlight is a colour + scale change, not the true gradient-fill
 *     text (`background-clip: text`) the CSS version uses — Skia can do a
 *     shader-based gradient fill for text, but that's a larger lift than
 *     this pass covers.
 *   - Inactive-line opacity snaps instantly on a line change rather than
 *     CSS-transitioning, and there's one word-entrance style, not a pool of
 *     24 chosen at random per line.
 *   - Only the active line gets per-word timing treatment, same as the
 *     original (context lines above/below render as plain text).
 *
 * NOT compiled or visually tested — see Starfield.tsx's header for why, and
 * why that risk is lower here than in the native Swift bridges.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import ReanimatedAnimated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { buildWordTimings, lineEnergy, type LyricCue, type WordTiming } from '@lyric-viewer/core';

const MAX_CONTEXT_DISTANCE = 2;
const OPACITY_BY_DISTANCE = [1, 0.5, 0.14];

function Word({
  timing,
  positionMs,
  accentColor,
}: {
  timing: WordTiming;
  positionMs: SharedValue<number>;
  accentColor: string;
}) {
  const style = useAnimatedStyle(() => {
    const p = positionMs.value;
    const active = p >= timing.startMs && p < timing.endMs;
    const sung = p >= timing.endMs;
    return {
      color: active || sung ? accentColor : 'rgba(255,255,255,0.55)',
      transform: [{ scale: active ? 1.12 : 1 }],
    };
  });
  return <ReanimatedAnimated.Text style={[styles.word, style]}>{timing.word} </ReanimatedAnimated.Text>;
}

function ActiveLine({
  cue,
  nextCueTimeMs,
  positionMs,
  accentColor,
}: {
  cue: LyricCue;
  nextCueTimeMs: number;
  positionMs: SharedValue<number>;
  accentColor: string;
}) {
  const timings = useMemo(
    () => buildWordTimings(cue.text, cue.timeMs, nextCueTimeMs),
    [cue.text, cue.timeMs, nextCueTimeMs]
  );
  return (
    <View style={styles.wordRow}>
      {timings.map((t, i) => (
        <Word key={i} timing={t} positionMs={positionMs} accentColor={accentColor} />
      ))}
    </View>
  );
}

export interface LyricColumnProps {
  cues: LyricCue[];
  translationCues: LyricCue[] | null;
  showTranslation: boolean;
  activeIndex: number;
  positionMs: SharedValue<number>;
  accentColor: string;
}

export function LyricColumn({
  cues,
  translationCues,
  showTranslation,
  activeIndex,
  positionMs,
  accentColor,
}: LyricColumnProps) {
  const [containerHeight, setContainerHeight] = useState(0);
  const scrollY = useRef(new Animated.Value(0)).current;
  const smoothedIntensity = useRef(0);
  const [activeScale, setActiveScale] = useState(1.35);

  const slotPx = containerHeight * 0.11;
  const targetCenterPx = containerHeight * 0.44;

  useEffect(() => {
    if (containerHeight === 0) return;
    if (activeIndex < 0) {
      Animated.timing(scrollY, { toValue: targetCenterPx, duration: 200, useNativeDriver: true }).start();
      return;
    }

    const energy = lineEnergy(cues, activeIndex);
    smoothedIntensity.current = smoothedIntensity.current * 0.4 + energy * 0.6;
    const chars = (cues[activeIndex]?.text || '').length;
    const fit = Math.max(0.6, Math.min(1, 26 / Math.max(1, chars)));
    setActiveScale(Math.min(2.0, (1.35 + smoothedIntensity.current * 0.85) * fit));

    const next = cues[activeIndex + 1];
    const cue = cues[activeIndex];
    const durationMs = Math.max(250, (next ? next.timeMs : cue.timeMs + 3000) - cue.timeMs);
    const dur = Math.max(150, Math.min(460, durationMs * 0.28));

    const shift = targetCenterPx - (activeIndex + 0.5) * slotPx;
    Animated.timing(scrollY, { toValue: shift, duration: dur, useNativeDriver: true }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, containerHeight, cues]);

  const onLayout = (e: LayoutChangeEvent) => setContainerHeight(e.nativeEvent.layout.height);

  const translationText =
    showTranslation && translationCues && activeIndex >= 0 && activeIndex < translationCues.length
      ? translationCues[activeIndex]?.text ?? ''
      : '';

  return (
    <View style={styles.container} onLayout={onLayout}>
      <Animated.View style={[styles.column, { transform: [{ translateY: scrollY }] }]}>
        {cues.map((cue, i) => {
          const distance = Math.abs(i - activeIndex);
          const isActive = i === activeIndex;
          const opacity = isActive ? 1 : OPACITY_BY_DISTANCE[Math.min(distance, MAX_CONTEXT_DISTANCE)] ?? 0;
          if (opacity === 0) return <View key={i} style={{ height: slotPx }} />;

          return (
            <View key={i} style={[styles.lineSlot, { height: slotPx, opacity }]}>
              {isActive ? (
                <View style={{ transform: [{ scale: activeScale }] }}>
                  <ActiveLine
                    cue={cue}
                    nextCueTimeMs={cues[i + 1]?.timeMs ?? cue.timeMs + 4000}
                    positionMs={positionMs}
                    accentColor={accentColor}
                  />
                </View>
              ) : (
                <Text style={styles.line} numberOfLines={2}>
                  {cue.text || ' '}
                </Text>
              )}
            </View>
          );
        })}
      </Animated.View>

      {translationText ? (
        <View style={styles.translationWrap} pointerEvents="none">
          <Text style={styles.translation}>{translationText}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, width: '100%', overflow: 'hidden' },
  column: { position: 'absolute', left: '10%', right: '10%' },
  lineSlot: { alignItems: 'center', justifyContent: 'center' },
  line: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 26,
    fontWeight: '700',
    textAlign: 'center',
  },
  wordRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  word: { fontSize: 26, fontWeight: '700' },
  translationWrap: { position: 'absolute', bottom: '18%', left: '10%', right: '10%' },
  translation: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 16,
    fontStyle: 'italic',
    textAlign: 'center',
  },
});
