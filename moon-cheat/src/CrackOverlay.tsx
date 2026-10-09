import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { crackLayers, generateGlass } from "./cracks";

/**
 * Glass cracks that start at the screen edges and spread inward as `progress`
 * (taps / target) rises. Reverse contrast: dark mode -> white glass, black cracks;
 * light mode -> black glass, white cracks.
 */
export function CrackOverlay({
  w, h, seed, progress, dark,
}: { w: number; h: number; seed: number; progress: number; dark: boolean }) {
  const system = useMemo(() => (w && h ? generateGlass(w, h, seed) : null), [w, h, seed]);

  // Rebuild path strings at most ~120 times over the whole 0..1 range.
  const q = Math.round(progress * 120) / 120;
  const L = useMemo(() => (system && q > 0 ? crackLayers(system, q) : null), [system, q]);
  if (!L) return null;

  const inverse = dark ? "#ffffff" : "#000000";
  const base = dark ? "#000000" : "#ffffff";
  const s = L.scale;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={w} height={h}>
        <Defs>
          <RadialGradient id="pool" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={inverse} stopOpacity="1" />
            <Stop offset="0.55" stopColor={inverse} stopOpacity="0.8" />
            <Stop offset="1" stopColor={inverse} stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {L.pools.map((p, i) => (
          <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill="url(#pool)" opacity={p.alpha} />
        ))}
        {L.fillOpacity > 0 && <Rect width={w} height={h} fill={inverse} opacity={L.fillOpacity} />}

        {/* glass glints in the inverse colour */}
        <Path d={L.lines} stroke={inverse} strokeWidth={7 * s} strokeOpacity={0.1} fill="none" strokeLinecap="round" />
        <Path d={L.lines} stroke={inverse} strokeWidth={2.6 * s} strokeOpacity={0.45} fill="none" strokeLinecap="round" />
        <Path d={L.lines} stroke={inverse} strokeWidth={1.2 * s} strokeOpacity={0.95} fill="none" strokeLinecap="round" />
        <Path d={L.shards} fill={inverse} fillOpacity={0.45} />
        <Path d={L.scratches} stroke={inverse} strokeWidth={0.6} strokeOpacity={0.3} fill="none" />

        {/* stark base-colour cracks, fading in as the screen becomes the inverse colour */}
        <Path d={L.lines} stroke={base} strokeWidth={0.9 * s} strokeOpacity={L.coreOpacity} fill="none" strokeLinecap="round" />
        <Path d={L.shards} fill={base} fillOpacity={0.5 * L.coreOpacity} />
        <Path d={L.scratches} stroke={base} strokeWidth={0.6} strokeOpacity={0.5 * L.coreOpacity} fill="none" />
      </Svg>
    </View>
  );
}
