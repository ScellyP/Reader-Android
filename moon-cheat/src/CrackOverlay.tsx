import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, G, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { crackLayers, facetAlpha, generateGlass, renderProgress, terminalPalette } from "./cracks";

/**
 * Shattered glass. Four impacts (one per screen edge, 26 rays each) grow inward as `progress`
 * (taps / target) rises; the gaps between cracks fill with shaded facets in three brightness
 * tiers. At progress 1 the screen inverts: dark mode -> white glass + black cracks,
 * light mode -> black glass + white cracks.
 */
export function CrackOverlay({
  w, h, seed, progress, dark,
}: { w: number; h: number; seed: number; progress: number; dark: boolean }) {
  const system = useMemo(() => (w && h ? generateGlass(w, h, seed) : null), [w, h, seed]);

  // Path strings are rebuilt at most RENDER_STEPS times over the whole 0..1 range.
  const q = renderProgress(progress);
  const L = useMemo(() => (system && q > 0 ? crackLayers(system, q) : null), [system, q]);
  if (!L) return null;

  const terminal = q >= 1 ? terminalPalette(dark) : null;
  const inverse = terminal ? terminal.fill : dark ? "#ffffff" : "#000000";
  const base = terminal ? terminal.crack : dark ? "#000000" : "#ffffff";
  const s = L.scale;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={w} height={h}>
        <Defs>
          <RadialGradient id="pool" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={inverse} stopOpacity="0.75" />
            <Stop offset="1" stopColor={inverse} stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {L.pools.map((p, i) => (
          <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill="url(#pool)" opacity={p.alpha} />
        ))}
        {L.fillOpacity > 0 && <Rect width={w} height={h} fill={inverse} opacity={L.fillOpacity} />}

        {/* glass facets: three brightness tiers, fading out under the terminal fill */}
        {[0, 1, 2].map((lv) =>
          L.facets[lv] ? <Path key={lv} d={L.facets[lv]} fill={inverse} fillOpacity={facetAlpha(lv, dark) * L.facetFade} /> : null
        )}

        {/* glints in the inverse colour */}
        <Path d={L.lines} stroke={inverse} strokeWidth={7 * s} strokeOpacity={0.1} fill="none" strokeLinecap="round" />
        <Path d={L.lines} stroke={inverse} strokeWidth={2.6 * s} strokeOpacity={0.45} fill="none" strokeLinecap="round" />
        <Path d={L.lines} stroke={inverse} strokeWidth={1.2 * s} strokeOpacity={0.95} fill="none" strokeLinecap="round" />
        <Path d={L.shards} fill={inverse} fillOpacity={0.38 * L.facetFade} />
        <Path d={L.scratches} stroke={inverse} strokeWidth={0.6} strokeOpacity={0.3} fill="none" />

        {/* stark base-colour cracks, fading in as the screen turns to the inverse colour */}
        <Path d={L.lines} stroke={base} strokeWidth={(q >= 1 ? 1.7 : 0.9 * s)} strokeOpacity={L.coreOpacity} fill="none" strokeLinecap="round" />
        <Path d={L.shards} fill={base} fillOpacity={0.5 * L.coreOpacity} />
        <Path d={L.scratches} stroke={base} strokeWidth={0.6} strokeOpacity={0.5 * L.coreOpacity} fill="none" />

        {/* impact starbursts: radius and brightness follow each web's own progress */}
        <G stroke={inverse} fill="none" strokeLinecap="round">
          {L.flashes.map((f, i) => (
            <Path key={i} d={f.path} strokeWidth={f.width} strokeOpacity={f.opacity} />
          ))}
        </G>
      </Svg>
    </View>
  );
}
