import React from "react";
import Svg, { Circle, Path } from "react-native-svg";
import { moonLitPath } from "./moonPhase";

export function MoonPhaseIcon({
  phaseIndex, size = 120, lit, dim,
}: { phaseIndex: number; size?: number; lit: string; dim: string }) {
  const c = size / 2, r = size * 0.42;
  return (
    <Svg width={size} height={size}>
      <Circle cx={c} cy={c} r={r} fill={dim} stroke={lit} strokeOpacity={0.35} strokeWidth={1.5} />
      {phaseIndex % 8 !== 0 && <Path d={moonLitPath(phaseIndex, c, c, r)} fill={lit} />}
    </Svg>
  );
}
