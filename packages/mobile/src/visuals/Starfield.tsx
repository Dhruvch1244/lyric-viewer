/**
 * GPU-accelerated backdrop: per-track colour wash, drifting glow orbs,
 * twinkling starfield, vignette, build-up bloom, and drop flash + shockwave
 * ring. The Phase 2 counterpart to `drawBackdrop()` in
 * src/renderer/renderer.js — covers that function's signature elements, not
 * a 1:1 port. Explicitly NOT ported (see packages/mobile/README.md for why):
 * aurora bands, bokeh, the equalizer, light rays, ripples, confetti, and
 * shooting stars. Those are decorative/secondary layers in the original;
 * this covers the ones that define the app's actual look.
 *
 * Everything here is driven by shared values updated by `useLyricEngine`
 * (see ../useLyricEngine.ts) using a "timestamp + pure derived math" design
 * instead of an imperative per-frame decay loop: e.g. a drop's flash is
 * `max(0, 1 - (now - dropAt) / DROP_DECAY_MS)`, not a mutable value ticked
 * down every frame. This is the idiomatic Reanimated + Skia pattern (see
 * useDerivedValue below) and avoids a whole class of stale-closure bugs.
 *
 * NOT compiled or visually tested — written in a Linux environment with no
 * Xcode/iOS Simulator. The Skia/Reanimated API calls follow their documented
 * shapes as of react-native-skia ~1.5 / react-native-reanimated ~3.16, but
 * this is JS/TS, not native Swift — `expo start`'s Metro bundler will
 * surface any real mistakes here fast and with a clear stack trace, unlike
 * the native bridges which need a full Xcode compile to find out.
 */

import React, { useMemo, useState } from 'react';
import { LayoutChangeEvent, View } from 'react-native';
import {
  Canvas,
  Fill,
  Circle,
  Group,
  Path,
  RadialGradient,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { hexA } from '@lyric-viewer/core';

const DROP_DECAY_MS = 900;
const LINE_PULSE_DECAY_MS = 550;

// Worklet-local copies of @lyric-viewer/core's hexA/shiftHex colour math.
// Functions imported from another package aren't auto-workletized by
// Reanimated's babel plugin (it only processes this app's own source), so
// calling the shared core versions from inside a `'worklet'` derived value
// would throw at runtime — these small, pure functions are duplicated here
// instead. Keep them in sync with packages/core/src/palette.ts by hand if
// the colour math ever changes.
function hslHexWorklet(h: number, s: number, l: number): string {
  'worklet';
  const sf = s / 100;
  const lf = l / 100;
  const a = sf * Math.min(lf, 1 - lf);
  const f = (n: number) => {
    'worklet';
    const k = (n + h / 30) % 12;
    const c = lf - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, c)))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function shiftHexWorklet(hex: string, deg: number): string {
  'worklet';
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return hslHexWorklet((h + deg) % 360, s * 100, l * 100);
}

const BACKDROP_LEVEL_ALPHA = [0.34, 0.62, 0.84, 1.0] as const; // ghost, tinted, vivid, solid

export interface StarfieldEngineValues {
  /** ms clock, updated every frame. */
  now: SharedValue<number>;
  /** Date.now()-style timestamp the current line started, or 0. */
  lineStartAt: SharedValue<number>;
  /** 0..1 cadence energy of the current line, for the pulse kick. */
  lineEnergyValue: SharedValue<number>;
  /** Date.now()-style timestamps bounding a pending build-up ramp, or 0/0. */
  buildupStartAt: SharedValue<number>;
  buildupEndAt: SharedValue<number>;
  /** Date.now()-style timestamp of the most recent drop, or 0. */
  dropAt: SharedValue<number>;
  /** 0..1 baseline energy from sentiment analysis; floor of ambient motion. */
  baseEnergy: SharedValue<number>;
}

export interface StarfieldProps extends StarfieldEngineValues {
  /** [baseTint, glowA, glowB, accent] */
  palette: [string, string, string, string];
  /** 0-3: ghost/tinted/vivid/solid — see the ◐ chip in the original app. */
  backdropLevel: number;
}

interface StarSeed {
  x0: number;
  y0: number;
  r: number;
  driftSpeed: number;
}

interface OrbSeed {
  baseX: number;
  baseY: number;
  ampX: number;
  ampY: number;
  speed: number;
  phase: number;
}

/**
 * One drifting glow orb. Pulled out as its own component (rather than
 * building its useDerivedValue calls inside a .map()) because hooks can't be
 * called inside a loop — a separate component per list item keeps each
 * orb's hooks at a stable, independent call site.
 */
function GlowOrb({
  now,
  orb,
  width,
  height,
  radius,
  color,
}: {
  now: SharedValue<number>;
  orb: OrbSeed;
  width: number;
  height: number;
  radius: number;
  color: string;
}) {
  const cx = useDerivedValue(() => {
    'worklet';
    return (orb.baseX + Math.sin(now.value * orb.speed + orb.phase) * orb.ampX) * width;
  }, [now, width]);
  const cy = useDerivedValue(() => {
    'worklet';
    return (orb.baseY + Math.cos(now.value * orb.speed * 0.8 + orb.phase) * orb.ampY) * height;
  }, [now, height]);

  return (
    <Circle cx={cx} cy={cy} r={radius}>
      <RadialGradient
        c={vec(radius, radius)}
        r={radius}
        colors={[hexA(color, 0.4), hexA(color, 0.13), hexA(color, 0)]}
      />
    </Circle>
  );
}

function makeStarSeeds(count: number): StarSeed[] {
  return Array.from({ length: count }, () => ({
    x0: Math.random(),
    y0: Math.random(),
    r: Math.random() * 1.4 + 0.3,
    driftSpeed: Math.random() * 0.00002 + 0.000008,
  }));
}

export function Starfield({
  palette,
  backdropLevel,
  now,
  lineStartAt,
  lineEnergyValue,
  buildupStartAt,
  buildupEndAt,
  dropAt,
  baseEnergy,
}: StarfieldProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  };

  const starSeeds = useMemo(() => makeStarSeeds(150), []);
  const orbSeeds = useMemo(
    () =>
      [0, 1, 2].map((i) => ({
        baseX: 0.25 + i * 0.28,
        baseY: 0.32 + (i % 2) * 0.22,
        ampX: 0.08 + Math.random() * 0.05,
        ampY: 0.06 + Math.random() * 0.05,
        speed: (0.00015 + Math.random() * 0.0002) * (i % 2 ? 1 : -1),
        phase: i * 2.1,
      })),
    []
  );

  const { width, height } = size;
  const maxDim = Math.max(width, height, 1);

  // --- derived, pure-function-of-time values -------------------------------

  const bgHue = useDerivedValue(() => {
    'worklet';
    return (now.value * 0.015 * (0.6 + baseEnergy.value)) % 360;
  }, [baseEnergy]);

  const pulse = useDerivedValue(() => {
    'worklet';
    if (lineStartAt.value <= 0) return 0;
    const elapsed = now.value - lineStartAt.value;
    if (elapsed < 0 || elapsed > LINE_PULSE_DECAY_MS * 3) return 0;
    return lineEnergyValue.value * Math.exp(-elapsed / LINE_PULSE_DECAY_MS);
  }, [lineStartAt, lineEnergyValue]);

  const buildup = useDerivedValue(() => {
    'worklet';
    const start = buildupStartAt.value;
    const end = buildupEndAt.value;
    if (end <= start) return 0;
    return Math.max(0, Math.min(1, (now.value - start) / (end - start)));
  }, [buildupStartAt, buildupEndAt]);

  const dropFlash = useDerivedValue(() => {
    'worklet';
    if (dropAt.value <= 0) return 0;
    const elapsed = now.value - dropAt.value;
    if (elapsed < 0 || elapsed > DROP_DECAY_MS) return 0;
    return 1 - elapsed / DROP_DECAY_MS;
  }, [dropAt]);

  const washColor = useDerivedValue(() => {
    'worklet';
    return shiftHexWorklet(palette[0], bgHue.value * 0.5);
  }, [bgHue, palette]);

  const washAlpha = useDerivedValue(() => {
    'worklet';
    const level = BACKDROP_LEVEL_ALPHA[backdropLevel] ?? BACKDROP_LEVEL_ALPHA[2];
    return Math.min(1, level + buildup.value * 0.12 + dropFlash.value * 0.15);
  }, [buildup, dropFlash, backdropLevel]);

  const starsPath = useDerivedValue(() => {
    'worklet';
    const path = Skia.Path.Make();
    for (const s of starSeeds) {
      const y = (((s.y0 - now.value * s.driftSpeed) % 1) + 1) % 1;
      path.addCircle(s.x0 * width, y * height, s.r);
    }
    return path;
  }, [starSeeds, width, height]);

  const starsOpacity = useDerivedValue(() => {
    'worklet';
    const twinkle = 0.75 + 0.25 * Math.sin(now.value / 900);
    const life = Math.min(1, pulse.value + baseEnergy.value * 0.4 + 0.15);
    return Math.min(1, 0.55 * twinkle * (0.7 + life * 0.9));
  }, [pulse, baseEnergy]);

  const dropRingRadius = useDerivedValue(() => {
    'worklet';
    return (1 - dropFlash.value) * maxDim * 0.95;
  }, [dropFlash, maxDim]);

  const dropRingOpacity = useDerivedValue(() => {
    'worklet';
    return dropFlash.value * 0.7;
  }, [dropFlash]);

  const dropFillOpacity = useDerivedValue(() => {
    'worklet';
    return Math.min(0.75, dropFlash.value * 0.75);
  }, [dropFlash]);

  const dropWhiteOpacity = useDerivedValue(() => {
    'worklet';
    return dropFlash.value > 0.6 ? (dropFlash.value - 0.6) * 1.1 : 0;
  }, [dropFlash]);

  const buildupBloomOpacity = useDerivedValue(() => {
    'worklet';
    return buildup.value > 0.02 ? buildup.value * 0.6 : 0;
  }, [buildup]);

  const buildupBloomRadius = useDerivedValue(() => {
    'worklet';
    return maxDim * (0.25 + buildup.value * 0.55);
  }, [buildup, maxDim]);

  const accentLive = useDerivedValue(() => {
    'worklet';
    return shiftHexWorklet(palette[3], bgHue.value);
  }, [bgHue, palette]);

  if (width === 0 || height === 0) {
    return <View style={{ flex: 1 }} onLayout={onLayout} />;
  }

  return (
    <View style={{ flex: 1 }} onLayout={onLayout}>
      <Canvas style={{ flex: 1 }}>
        {/* Per-track/mood wash across the whole screen. */}
        <Fill color={washColor} opacity={washAlpha} />

        {/* Drifting glow orbs — three per palette, matching seedGlows(). */}
        <Group blendMode="plus">
          {orbSeeds.map((orb, i) => (
            <GlowOrb
              key={i}
              now={now}
              orb={orb}
              width={width}
              height={height}
              radius={maxDim * (0.3 + (i % 2) * 0.08)}
              color={i === 1 ? palette[2] : palette[1]}
            />
          ))}
        </Group>

        {/* Starfield. */}
        <Path path={starsPath} color="white" opacity={starsOpacity} style="fill" />

        {/* Vignette. */}
        <Circle cx={width / 2} cy={height * 0.5} r={maxDim * 0.8}>
          <RadialGradient
            c={vec(width / 2, height * 0.5)}
            r={maxDim * 0.8}
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.45)']}
          />
        </Circle>

        {/* Build-up bloom: accent glow swelling at centre as a drop approaches. */}
        <Circle cx={width / 2} cy={height * 0.5} r={buildupBloomRadius} opacity={buildupBloomOpacity} blendMode="plus">
          <RadialGradient
            c={vec(width / 2, height * 0.5)}
            r={buildupBloomRadius}
            colors={[hexA(palette[3], 0.4), hexA(palette[3], 0.13), hexA(palette[3], 0)]}
          />
        </Circle>

        {/* Drop flash: accent flood + white core spike + expanding shockwave ring. */}
        <Group blendMode="plus">
          <Fill color={accentLive} opacity={dropFillOpacity} />
          <Fill color="white" opacity={dropWhiteOpacity} />
          <Circle
            cx={width / 2}
            cy={height * 0.5}
            r={dropRingRadius}
            style="stroke"
            strokeWidth={5}
            color="white"
            opacity={dropRingOpacity}
          />
        </Group>
      </Canvas>
    </View>
  );
}
