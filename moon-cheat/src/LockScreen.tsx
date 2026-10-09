import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View, useColorScheme } from "react-native";
import { isCheatDay } from "./cheatDay";
import { TapProgress, TapState } from "./cheatCode";
import { grantOneHourUnlock } from "./unlockWindow";
import { MoonPhaseIcon } from "./MoonPhaseIcon";
import { CrackOverlay } from "./CrackOverlay";
import { useTween } from "./useTween";

const MOON = 120;
const FULL_MOON = 4;

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const dark = useColorScheme() !== "light";
  const bg = dark ? "#0b0b10" : "#f6f4ee";
  const text = dark ? "#e8e6df" : "#1c1c28";
  const moonLit = dark ? "#f3efe0" : "#1c1c28";
  const moonDim = dark ? "#2a2a36" : "#d9d6cc";

  const cheatActive = useMemo(() => isCheatDay(new Date()), []);
  const tracker = useMemo(() => (cheatActive ? new TapProgress() : null), [cheatActive]);
  const [state, setState] = useState<TapState>(
    tracker?.state ?? { count: 0, target: 1, progress: 0, phaseIndex: FULL_MOON, done: false }
  );
  const [size, setSize] = useState({ w: 0, h: 0 });
  const seed = useMemo(() => (Math.random() * 2 ** 31) | 0, []);
  const granted = useRef(false);
  const pulse = useRef(new Animated.Value(1)).current;

  // Cracks ease toward progress; the last stretch (covering the screen) is slower.
  const shown = useTween(state.progress, state.done ? 900 : 350);

  const onTap = () => {
    if (!tracker) return;
    const s = tracker.tap();
    setState(s);
    pulse.setValue(0.88);
    Animated.spring(pulse, { toValue: 1, useNativeDriver: true, friction: 4 }).start();
    if (s.done && !granted.current) {
      granted.current = true;
      grantOneHourUnlock(); // persisted immediately; UI hand-off waits for the animation
    }
  };

  // Screen fully covered -> launch the normal interface.
  useEffect(() => {
    if (state.done && shown >= 1) {
      const t = setTimeout(onUnlocked, 250);
      return () => clearTimeout(t);
    }
  }, [state.done, shown]);

  const cx = size.w / 2;
  const cy = size.h / 2;

  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: bg }]}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      <Text style={[styles.clock, { color: text, top: size.h * 0.18 }]}>12:00 - Locked</Text>

      {/* Moon stays a plain static icon on non-cheat days (no handler, no animation). */}
      <Pressable
        onPress={tracker ? onTap : undefined}
        disabled={!tracker}
        accessible={false}
        style={{ position: "absolute", left: cx - MOON / 2, top: cy - MOON / 2 }}
      >
        <Animated.View style={{ transform: [{ scale: pulse }] }}>
          <MoonPhaseIcon phaseIndex={state.phaseIndex} size={MOON} lit={moonLit} dim={moonDim} />
        </Animated.View>
      </Pressable>

      {tracker && (
        <CrackOverlay w={size.w} h={size.h} seed={seed} progress={shown} dark={dark} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  clock: { position: "absolute", width: "100%", textAlign: "center", fontSize: 22 },
});
