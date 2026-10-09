import React, { useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { isCheatDay } from "./cheatDay";
import { MoonTapCheat } from "./cheatCode";
import { grantOneHourUnlock } from "./unlockWindow";

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  // Evaluated once each time the lock screen mounts.
  const cheatActive = useMemo(() => isCheatDay(new Date()), []);

  const cheat = useMemo(
    () =>
      cheatActive
        ? new MoonTapCheat(async () => {
            await grantOneHourUnlock();
            onUnlocked();
          })
        : null,
    [cheatActive]
  );

  useEffect(() => () => cheat?.dispose(), [cheat]);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>12:00 - Locked</Text>
      {/* On non-cheat days no handler is attached: the moon is just an icon. */}
      <Pressable
        onPress={cheat ? () => cheat.tap() : undefined}
        disabled={!cheat}
        accessible={false}
      >
        <Text style={{ fontSize: 48 }}>🌙</Text>
      </Pressable>
    </View>
  );
}
