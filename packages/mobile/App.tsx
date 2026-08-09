/**
 * Full-screen synced lyric overlay. Phase 2 of the iOS cross-platform plan:
 * replaces Phase 1's plain-text validation shell with the real visual
 * system — see src/visuals/Starfield.tsx and LyricColumn.tsx for what's
 * covered and what's explicitly simplified/deferred versus the Windows
 * app's src/renderer/renderer.js.
 */

import React from 'react';
import { SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Starfield } from './src/visuals/Starfield';
import { LyricColumn } from './src/visuals/LyricColumn';
import { useLyricEngine } from './src/useLyricEngine';

export default function App() {
  const { track, cues, translationCues, showTranslation, activeIndex, statusText, palette, backdropLevel, positionMs, starfieldValues } =
    useLyricEngine();

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <Starfield palette={palette} backdropLevel={backdropLevel} {...starfieldValues} />

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.header} pointerEvents="none">
          {track ? (
            <>
              <Text style={styles.title}>{track.title}</Text>
              <Text style={styles.artist}>
                {track.artist} · {track.sourceApp}
              </Text>
            </>
          ) : (
            <Text style={styles.artist}>{statusText}</Text>
          )}
        </View>

        <View style={styles.columnWrap}>
          <LyricColumn
            cues={cues}
            translationCues={translationCues}
            showTranslation={showTranslation}
            activeIndex={activeIndex}
            positionMs={positionMs}
            accentColor={palette[3]}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFillObject },
  header: { alignItems: 'center', paddingTop: 12 },
  title: { color: '#fff', fontSize: 15, fontWeight: '600' },
  artist: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 2 },
  columnWrap: { flex: 1 },
});
