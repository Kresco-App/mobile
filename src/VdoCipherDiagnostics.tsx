import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import type { ComponentType } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  NativeModules,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';

declare const require: (moduleName: string) => unknown;

const queryClient = new QueryClient();

const TOKEN_KEY = 'kresco.mobile.test.jwt';
const API_BASE_KEY = 'kresco.mobile.test.apiBaseUrl';
const DEFAULT_API_BASE_URL = 'http://localhost:8000';

type StreamResponse = {
  otp: string;
  playback_info: string;
  watched_seconds?: number;
  resume_seconds?: number;
};

type EmbedInfo = {
  otp: string;
  playbackInfo: string;
  enableAutoResume?: boolean;
  forceLowestBitrate?: boolean;
  resumeTimeMs?: number;
};

type MediaInfo = {
  mediaId: string;
  type: string;
  title: string;
  description: string;
  duration: number;
};

type Track = {
  id: number;
  type: string;
  language: string;
  bitrate: number;
  width: number;
  height: number;
  label: string;
};

type LogEntry = {
  id: number;
  time: string;
  label: string;
  detail?: string;
};

type PostKind = 'progress' | 'complete';

const {
  startVideoScreen,
  VdoPlayerView,
} = require('vdocipher-rn-bridge') as {
  startVideoScreen: (params: { embedInfo: EmbedInfo }, setPictureInPictureSupport?: boolean) => void;
  VdoPlayerView: ComponentType<any>;
};

function isVdoBridgeAvailable() {
  return Boolean(NativeModules.VdocipherRnBridge && NativeModules.VdoEventEmitter);
}

function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function authHeader(token: string) {
  const trimmed = token.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed : `Bearer ${trimmed}`;
}

function formatMs(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactForLog);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        if (['otp', 'playbackInfo', 'playback_info', 'token', 'access_token', 'authorization'].includes(key)) {
          return [key, '[redacted]'];
        }

        return [key, redactForLog(nested)];
      }),
    );
  }

  return value;
}

function stringifyLogDetail(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(redactForLog(value));
  } catch {
    return String(value);
  }
}

function KrescoMobileApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <VdoCipherDiagnostics />
    </QueryClientProvider>
  );
}

function VdoCipherDiagnostics() {
  const playerRef = useRef<any>(null);
  const lastLoggedProgressSecondRef = useRef(-1);
  const vdoAvailable = isVdoBridgeAvailable();

  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [bearerToken, setBearerToken] = useState('');
  const [itemId, setItemId] = useState('');
  const [manualOtp, setManualOtp] = useState('');
  const [manualPlaybackInfo, setManualPlaybackInfo] = useState('');
  const [forceLowestBitrate, setForceLowestBitrate] = useState(false);
  const [autoCompleteOnEnd, setAutoCompleteOnEnd] = useState(false);
  const [embedInfo, setEmbedInfo] = useState<EmbedInfo | null>(null);
  const [source, setSource] = useState('none');
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [progressMs, setProgressMs] = useState(0);
  const [bufferMs, setBufferMs] = useState(0);
  const [playerState, setPlayerState] = useState('idle');
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const appendLog = (label: string, detail?: unknown) => {
    const entry: LogEntry = {
      id: Date.now() + Math.random(),
      time: new Date().toLocaleTimeString(),
      label,
      detail: stringifyLogDetail(detail),
    };

    setLogs((current) => [entry, ...current].slice(0, 40));
  };

  useEffect(() => {
    let mounted = true;

    async function loadStoredValues() {
      try {
        const [storedToken, storedApiBaseUrl] = await Promise.all([
          SecureStore.getItemAsync(TOKEN_KEY),
          SecureStore.getItemAsync(API_BASE_KEY),
        ]);

        if (!mounted) {
          return;
        }

        if (storedToken) {
          setBearerToken(storedToken);
        }

        if (storedApiBaseUrl) {
          setApiBaseUrl(storedApiBaseUrl);
        }
      } catch (error) {
        appendLog('secure-store-load-failed', { message: String(error) });
      }
    }

    void loadStoredValues();

    return () => {
      mounted = false;
    };
  }, []);

  const activeEmbedInfo = useMemo(() => {
    if (!embedInfo) {
      return null;
    }

    return {
      ...embedInfo,
      forceLowestBitrate,
    };
  }, [embedInfo, forceLowestBitrate]);

  const fetchStreamMutation = useMutation({
    mutationFn: async () => {
      if (!itemId.trim()) {
        throw new Error('Enter a topic item ID first.');
      }

      const authorization = authHeader(bearerToken);

      if (!authorization) {
        throw new Error('Paste a Kresco JWT first.');
      }

      const url = `${trimTrailingSlash(apiBaseUrl)}/api/courses/topic-items/${encodeURIComponent(itemId.trim())}/stream`;
      const response = await fetch(url, {
        headers: {
          Authorization: authorization,
        },
      });

      const bodyText = await response.text();

      if (!response.ok) {
        throw new Error(`Stream request failed ${response.status}: ${bodyText}`);
      }

      return JSON.parse(bodyText) as StreamResponse;
    },
    onSuccess: (stream) => {
      const resumeTimeMs = Math.max(0, Number(stream.resume_seconds ?? 0)) * 1000;
      setEmbedInfo({
        otp: stream.otp,
        playbackInfo: stream.playback_info,
        resumeTimeMs,
        enableAutoResume: false,
        forceLowestBitrate,
      });
      setSource(`backend item ${itemId.trim()}`);
      setProgressMs(Math.max(0, Number(stream.watched_seconds ?? 0)) * 1000);
      appendLog('stream-loaded', {
        itemId,
        watched_seconds: stream.watched_seconds,
        resume_seconds: stream.resume_seconds,
      });
    },
    onError: (error) => {
      appendLog('stream-error', { message: error instanceof Error ? error.message : String(error) });
    },
  });

  const postProgressMutation = useMutation({
    mutationFn: async (kind: PostKind) => {
      if (!itemId.trim()) {
        throw new Error('Enter a topic item ID first.');
      }

      const authorization = authHeader(bearerToken);

      if (!authorization) {
        throw new Error('Paste a Kresco JWT first.');
      }

      const watchedSeconds = Math.max(0, Math.floor(progressMs / 1000));
      const suffix = kind === 'complete' ? 'complete' : 'progress';
      const url = `${trimTrailingSlash(apiBaseUrl)}/api/courses/topic-items/${encodeURIComponent(itemId.trim())}/${suffix}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ watched_seconds: watchedSeconds }),
      });

      const bodyText = await response.text();

      if (!response.ok) {
        throw new Error(`${kind} request failed ${response.status}: ${bodyText}`);
      }

      return {
        kind,
        watchedSeconds,
        body: bodyText ? JSON.parse(bodyText) : null,
      };
    },
    onSuccess: (result) => {
      appendLog(`${result.kind}-posted`, result);
    },
    onError: (error) => {
      appendLog('progress-post-error', { message: error instanceof Error ? error.message : String(error) });
    },
  });

  const saveConnection = async () => {
    try {
      await Promise.all([
        SecureStore.setItemAsync(TOKEN_KEY, bearerToken.trim()),
        SecureStore.setItemAsync(API_BASE_KEY, trimTrailingSlash(apiBaseUrl)),
      ]);
      appendLog('connection-saved');
    } catch (error) {
      appendLog('secure-store-save-failed', { message: String(error) });
    }
  };

  const useManualEmbedInfo = () => {
    if (!manualOtp.trim() || !manualPlaybackInfo.trim()) {
      appendLog('manual-embed-rejected', { reason: 'OTP and playbackInfo are required.' });
      return;
    }

    setEmbedInfo({
      otp: manualOtp.trim(),
      playbackInfo: manualPlaybackInfo.trim(),
      forceLowestBitrate,
    });
    setSource('manual otp/playbackInfo');
    setProgressMs(0);
    setBufferMs(0);
    setMediaInfo(null);
    setTracks([]);
    appendLog('manual-embed-loaded');
  };

  const openFullscreen = () => {
    if (!activeEmbedInfo) {
      appendLog('fullscreen-rejected', { reason: 'No embedInfo loaded.' });
      return;
    }

    if (!vdoAvailable) {
      appendLog('fullscreen-rejected', { reason: 'VdoCipher native bridge is not available in this runtime.' });
      return;
    }

    startVideoScreen({ embedInfo: activeEmbedInfo }, Platform.OS === 'android');
    appendLog('fullscreen-opened', { pictureInPictureRequested: Platform.OS === 'android' });
  };

  const handleLoaded = (event: { mediaInfo: MediaInfo }) => {
    setMediaInfo(event.mediaInfo);
    appendLog('loaded', event);
  };

  const handleProgress = (event: { currentTime: number }) => {
    const currentTime = Number(event.currentTime || 0);
    setProgressMs(currentTime);

    const second = Math.floor(currentTime / 1000);
    if (second > 0 && second % 5 === 0 && lastLoggedProgressSecondRef.current !== second) {
      lastLoggedProgressSecondRef.current = second;
      appendLog('progress', { currentTime });
    }
  };

  const handleMediaEnded = () => {
    appendLog('ended', { watched_seconds: Math.max(0, Math.floor(progressMs / 1000)) });

    if (autoCompleteOnEnd) {
      postProgressMutation.mutate('complete');
    }
  };

  const controlsDisabled = !activeEmbedInfo || !vdoAvailable;
  const working = fetchStreamMutation.isPending || postProgressMutation.isPending;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboard}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.kicker}>Kresco mobile spike</Text>
            <Text style={styles.title}>VdoCipher native diagnostics</Text>
            <Text style={styles.subtitle}>
              Fetch a protected stream, render the native player, and capture playback callbacks.
            </Text>
          </View>

          <View style={styles.statusRow}>
            <StatusPill label="Runtime" value={Platform.OS} tone="neutral" />
            <StatusPill label="Bridge" value={vdoAvailable ? 'available' : 'missing'} tone={vdoAvailable ? 'good' : 'bad'} />
            <StatusPill label="State" value={playerState} tone={playerState === 'ready' ? 'good' : 'neutral'} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Backend stream</Text>
            <Field label="API base URL" value={apiBaseUrl} onChangeText={setApiBaseUrl} placeholder="http://192.168.1.10:8000" />
            <Field
              label="Kresco JWT"
              value={bearerToken}
              onChangeText={setBearerToken}
              placeholder="Paste access_token from /api/auth/mobile-session"
              multiline
              secureTextEntry={false}
            />
            <Field label="Topic item ID" value={itemId} onChangeText={setItemId} placeholder="123" keyboardType="number-pad" />

            <View style={styles.actions}>
              <ActionButton label="Save" onPress={() => void saveConnection()} />
              <ActionButton
                label="Fetch stream"
                onPress={() => fetchStreamMutation.mutate()}
                busy={fetchStreamMutation.isPending}
                primary
              />
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Manual embed</Text>
            <Field label="OTP" value={manualOtp} onChangeText={setManualOtp} placeholder="VdoCipher OTP" multiline />
            <Field
              label="Playback info"
              value={manualPlaybackInfo}
              onChangeText={setManualPlaybackInfo}
              placeholder="VdoCipher playbackInfo"
              multiline
            />
            <View style={styles.actions}>
              <ActionButton label="Use manual embed" onPress={useManualEmbedInfo} primary />
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Playback test</Text>
              <Text style={styles.sourceText}>{source}</Text>
            </View>

            <ToggleRow label="Force lowest bitrate" value={forceLowestBitrate} onValueChange={setForceLowestBitrate} />
            <ToggleRow label="Auto POST complete on end" value={autoCompleteOnEnd} onValueChange={setAutoCompleteOnEnd} />

            <View style={styles.playerFrame}>
              {activeEmbedInfo && vdoAvailable ? (
                <VdoPlayerView
                  key={`${source}-${activeEmbedInfo.otp ? 'otp' : 'token'}-${forceLowestBitrate}`}
                  ref={playerRef}
                  embedInfo={activeEmbedInfo}
                  autoPlay={false}
                  showNativeControls
                  style={styles.player}
                  onInitializationSuccess={(event: unknown) => appendLog('init-success', event)}
                  onInitializationFailure={(event: unknown) => appendLog('init-failure', event)}
                  onLoading={(event: unknown) => appendLog('loading', event)}
                  onLoaded={handleLoaded}
                  onLoadError={(event: unknown) => appendLog('load-error', event)}
                  onPlayerStateChanged={(event: { playerState: string }) => {
                    setPlayerState(event.playerState);
                    appendLog('state', event);
                  }}
                  onProgress={handleProgress}
                  onBufferUpdate={(event: { bufferTime: number }) => {
                    setBufferMs(Number(event.bufferTime || 0));
                  }}
                  onPlaybackSpeedChanged={(playbackSpeed: number) => appendLog('speed', { playbackSpeed })}
                  onTracksChanged={(event: { availableTracks?: Track[] }) => {
                    setTracks(event.availableTracks ?? []);
                    appendLog('tracks', event);
                  }}
                  onMediaEnded={handleMediaEnded}
                  onError={(event: unknown) => appendLog('playback-error', event)}
                  onEnterFullscreen={() => appendLog('enter-fullscreen')}
                  onExitFullscreen={() => appendLog('exit-fullscreen')}
                  onPictureInPictureModeChanged={(event: unknown) => appendLog('pip', event)}
                />
              ) : (
                <View style={styles.playerPlaceholder}>
                  <Text style={styles.placeholderTitle}>{activeEmbedInfo ? 'Native bridge unavailable' : 'No video loaded'}</Text>
                  <Text style={styles.placeholderBody}>
                    {activeEmbedInfo
                      ? 'Install an EAS development build. Expo Go and web cannot load VdoCipher native modules.'
                      : 'Fetch a backend stream or paste OTP/playbackInfo to start the native test.'}
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.metricGrid}>
              <Metric label="Progress" value={formatMs(progressMs)} />
              <Metric label="Buffer" value={formatMs(bufferMs)} />
              <Metric label="Duration" value={mediaInfo?.duration ? formatMs(mediaInfo.duration) : '--'} />
              <Metric label="Tracks" value={String(tracks.length)} />
            </View>

            <View style={styles.actions}>
              <ActionButton label="Play" onPress={() => playerRef.current?.play?.()} disabled={controlsDisabled} />
              <ActionButton label="Pause" onPress={() => playerRef.current?.pause?.()} disabled={controlsDisabled} />
              <ActionButton label="Fullscreen" onPress={openFullscreen} disabled={!activeEmbedInfo} />
            </View>

            <View style={styles.actions}>
              <ActionButton
                label="POST progress"
                onPress={() => postProgressMutation.mutate('progress')}
                busy={postProgressMutation.isPending}
                disabled={!itemId.trim()}
              />
              <ActionButton
                label="POST complete"
                onPress={() => postProgressMutation.mutate('complete')}
                busy={postProgressMutation.isPending}
                disabled={!itemId.trim()}
                primary
              />
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Event log</Text>
              {working ? <ActivityIndicator color="#38bdf8" /> : null}
            </View>

            {logs.length === 0 ? (
              <Text style={styles.emptyText}>Player and API events will appear here.</Text>
            ) : (
              logs.map((entry) => (
                <View key={entry.id} style={styles.logRow}>
                  <Text style={styles.logMeta}>
                    {entry.time}  {entry.label}
                  </Text>
                  {entry.detail ? <Text style={styles.logDetail}>{entry.detail}</Text> : null}
                </View>
              ))
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline,
  secureTextEntry,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'number-pad';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#64748b"
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        style={[styles.input, multiline && styles.inputMultiline]}
      />
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  primary,
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  const inactive = Boolean(disabled || busy);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        primary && styles.buttonPrimary,
        inactive && styles.buttonDisabled,
        pressed && !inactive && styles.buttonPressed,
      ]}
    >
      {busy ? <ActivityIndicator color={primary ? '#020617' : '#e2e8f0'} /> : <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>{label}</Text>}
    </Pressable>
  );
}

function ToggleRow({ label, value, onValueChange }: { label: string; value: boolean; onValueChange: (value: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} />
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: 'good' | 'bad' | 'neutral' }) {
  return (
    <View style={[styles.statusPill, tone === 'good' && styles.statusGood, tone === 'bad' && styles.statusBad]}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={styles.statusValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#07111f',
  },
  keyboard: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 40,
    gap: 16,
  },
  header: {
    gap: 8,
  },
  kicker: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  title: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '800',
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 15,
    lineHeight: 21,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusPill: {
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0f172a',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    minWidth: 96,
  },
  statusGood: {
    borderColor: '#16a34a',
  },
  statusBad: {
    borderColor: '#dc2626',
  },
  statusLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  statusValue: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },
  section: {
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    paddingTop: 16,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  sectionTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '800',
  },
  sourceText: {
    color: '#94a3b8',
    flexShrink: 1,
    fontSize: 12,
    textAlign: 'right',
  },
  field: {
    gap: 6,
  },
  label: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  inputMultiline: {
    minHeight: 86,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  button: {
    minHeight: 44,
    minWidth: 112,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#111827',
    paddingHorizontal: 14,
  },
  buttonPrimary: {
    borderColor: '#38bdf8',
    backgroundColor: '#38bdf8',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    transform: [{ scale: 0.98 }],
  },
  buttonText: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '800',
  },
  buttonTextPrimary: {
    color: '#020617',
  },
  toggleRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  toggleLabel: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '700',
  },
  playerFrame: {
    width: '100%',
    minHeight: 220,
    overflow: 'hidden',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#020617',
  },
  player: {
    minHeight: 220,
    width: '100%',
    resizeMode: 'contain',
  },
  playerPlaceholder: {
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 8,
  },
  placeholderTitle: {
    color: '#f8fafc',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  placeholderBody: {
    color: '#94a3b8',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metric: {
    width: '48%',
    minHeight: 62,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 10,
  },
  metricLabel: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  metricValue: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 4,
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 14,
  },
  logRow: {
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    paddingTop: 10,
    gap: 4,
  },
  logMeta: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '800',
  },
  logDetail: {
    color: '#94a3b8',
    fontSize: 12,
    lineHeight: 17,
  },
});

export default KrescoMobileApp;
