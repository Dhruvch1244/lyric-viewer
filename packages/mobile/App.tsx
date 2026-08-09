/**
 * Phase 1 minimal player shell: validates the detection → lyric-lookup →
 * sync pipeline end-to-end before Phase 2 builds the full Skia visual system
 * (starfield, glow, drop flash, dancers — see src/renderer/renderer.js for
 * what that eventually needs to match).
 *
 * This intentionally renders plain text, not the fullscreen visual
 * experience, so the riskiest part (two new native integrations — MusicKit
 * and Spotify App Remote) can be validated on a real device on its own.
 */

import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { fetchSyncedLyrics, findCueIndex, type LyricCue } from '@lyric-viewer/core';
import { AppleMusicSource } from './src/sources/AppleMusicSource';
import { SpotifySource } from './src/sources/SpotifySource';
import { SourceArbiter, type ArbitratedTrack } from './src/sources/SourceArbiter';

export default function App() {
  const [track, setTrack] = useState<ArbitratedTrack | null>(null);
  const [cues, setCues] = useState<LyricCue[]>([]);
  const [activeLine, setActiveLine] = useState('');
  const lookupToken = useRef(0);

  useEffect(() => {
    const arbiter = new SourceArbiter([new AppleMusicSource(), new SpotifySource()], {
      onTrack: async (t) => {
        setTrack(t);
        setCues([]);
        setActiveLine('');
        const token = ++lookupToken.current;
        try {
          const result = await fetchSyncedLyrics(t);
          if (token !== lookupToken.current) return;
          setCues(result?.cues ?? []);
        } catch (err) {
          if (token !== lookupToken.current) return;
          setActiveLine(`Lyric lookup failed: ${(err as Error).message}`);
        }
      },
      onTick: (tick) => {
        setCues((currentCues) => {
          const index = findCueIndex(currentCues, tick.positionMs);
          setActiveLine(index >= 0 ? currentCues[index].text : '');
          return currentCues;
        });
      },
      onIdle: () => {
        setTrack(null);
        setCues([]);
        setActiveLine('');
      },
    });

    arbiter.start();
    return () => arbiter.stop();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        {track ? (
          <>
            <Text style={styles.meta}>
              {track.artist} — {track.title} ({track.sourceApp})
            </Text>
            <Text style={styles.line}>{activeLine || '…'}</Text>
          </>
        ) : (
          <Text style={styles.meta}>Nothing playing in Apple Music or Spotify.</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  meta: { color: '#888', fontSize: 14, marginBottom: 12, textAlign: 'center' },
  line: { color: '#fff', fontSize: 28, fontWeight: '600', textAlign: 'center' },
});
