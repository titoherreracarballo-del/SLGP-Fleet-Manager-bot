import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, Modal, ScrollView, Vibration,
} from 'react-native';
import { Camera, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';

import { lookupVin } from '../data/vinDatabase';
import { ENDPOINTS, UPLOAD_TIMEOUT_MS, POLL_INTERVAL_MS } from '../config/api';

const INSPECTION_TYPES = ['Pre-Trip', 'Post-Trip'];

// ── Auto-select inspection type by time of day ────────────────────────────────
function autoInspectionType() {
  const hour = new Date().getHours();
  return hour < 13 ? 'Pre-Trip' : 'Post-Trip';
}

export default function VideoScreen({ navigation }) {
  useKeepAwake(); // prevents screen from sleeping during recording/upload

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  // ── Form state ────────────────────────────────────────────────────────────
  const [driverName,      setDriverName]      = useState('');
  const [vin,             setVin]             = useState('');
  const [vehicleType,     setVehicleType]     = useState('');
  const [vehicleFuel,     setVehicleFuel]     = useState('');
  const [hasTow,          setHasTow]          = useState(null);
  const [inspectionType,  setInspectionType]  = useState(autoInspectionType());
  const [userPickedType,  setUserPickedType]  = useState(false);

  // ── OPS Supervisor Mode ───────────────────────────────────────────────────
  const [isOpsMode,       setIsOpsMode]       = useState(false);
  const [opsDriverName,   setOpsDriverName]   = useState('');
  const [opsSupervisor,   setOpsSupervisor]   = useState('');

  // ── Recording state ───────────────────────────────────────────────────────
  const [isRecording,     setIsRecording]     = useState(false);
  const [recordingUri,    setRecordingUri]    = useState(null);
  const [seconds,         setSeconds]         = useState(0);
  const timerRef = useRef(null);

  // ── Upload state ──────────────────────────────────────────────────────────
  const [isUploading,     setIsUploading]     = useState(false);
  const [uploadProgress,  setUploadProgress]  = useState(0);
  const [uploadMessage,   setUploadMessage]   = useState('');
  const [jobId,           setJobId]           = useState(null);

  // ── Tow modal ─────────────────────────────────────────────────────────────
  const [towModal,        setTowModal]        = useState(null); // 'warning' | 'active' | null
  const lastModalVin = useRef(null);

  // ── Request camera permission on mount ───────────────────────────────────
  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, []);

  // ── VIN lookup ────────────────────────────────────────────────────────────
  const handleVinChange = useCallback((text) => {
    const upper = text.toUpperCase();
    setVin(upper);

    if (upper.length >= 4) {
      const result = lookupVin(upper);
      if (result) {
        setVehicleType(result.type);
        setVehicleFuel(result.fuel);
        setHasTow(result.tow);

        // Auto-select inspection type from VIN time if not manually chosen
        if (!userPickedType) {
          setInspectionType(autoInspectionType());
        }

        // Show tow modal once per VIN
        if (upper !== lastModalVin.current) {
          lastModalVin.current = upper;
          setTowModal(result.tow ? 'active' : 'warning');
        }
      } else {
        setVehicleType('Unknown Vehicle');
        setVehicleFuel('');
        setHasTow(null);
      }
    } else {
      setVehicleType('');
      setVehicleFuel('');
      setHasTow(null);
    }
  }, [userPickedType]);

  // ── Timer ─────────────────────────────────────────────────────────────────
  const startTimer = () => {
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
  };
  const stopTimer = () => {
    clearInterval(timerRef.current);
    timerRef.current = null;
  };
  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  // ── Recording ─────────────────────────────────────────────────────────────
  const startRecording = async () => {
    if (!driverName.trim()) {
      Alert.alert('Required', 'Please enter your driver name first.');
      return;
    }
    if (isOpsMode && !opsDriverName.trim()) {
      Alert.alert('OPS Mode', 'Please enter the driver's full name.');
      return;
    }
    if (isOpsMode && !opsSupervisor.trim()) {
      Alert.alert('OPS Mode', 'Please enter your supervisor name.');
      return;
    }
    if (!vin || vin.length < 4) {
      Alert.alert('Required', 'Please enter the last 4 digits of the VIN.');
      return;
    }
    if (!cameraRef.current) return;

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      setIsRecording(true);
      setRecordingUri(null);
      startTimer();

      const video = await cameraRef.current.recordAsync({
        maxDuration: 300,      // 5 min ceiling
        videoBitrate: 6_000_000, // 6 Mbps — matches current config
      });

      setRecordingUri(video.uri);
      stopTimer();
      setIsRecording(false);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Auto-upload 1s after recording stops
      setTimeout(() => uploadVideo(video.uri), 1000);
    } catch (err) {
      stopTimer();
      setIsRecording(false);
      console.error('Recording error:', err);
      Alert.alert('Recording Error', err.message || 'Failed to record video.');
    }
  };

  const stopRecording = async () => {
    if (cameraRef.current && isRecording) {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      cameraRef.current.stopRecording();
    }
  };

  // ── Upload ────────────────────────────────────────────────────────────────
  const uploadVideo = async (uri) => {
    if (!uri) return;

    setIsUploading(true);
    setUploadProgress(0);
    setUploadMessage('Preparing upload...');

    try {
      const fileInfo = await FileSystem.getInfoAsync(uri, { size: true });
      const sizeMB   = ((fileInfo.size || 0) / 1024 / 1024).toFixed(1);

      if (fileInfo.size > 100 * 1024 * 1024) {
        Alert.alert('Too Large', `Video is ${sizeMB}MB. Please keep walk-arounds under 30 seconds.`);
        setIsUploading(false);
        return;
      }

      setUploadMessage(`Uploading ${sizeMB}MB...`);

      // expo-file-system uploadAsync gives us real progress
      const uploadResult = await FileSystem.uploadAsync(
        ENDPOINTS.uploadVideo,
        uri,
        {
          httpMethod:   'POST',
          uploadType:   FileSystem.FileSystemUploadType.MULTIPART,
          fieldName:    'video',
          mimeType:     'video/mp4',
          parameters: {
            driverName:      isOpsMode ? opsDriverName.trim() : driverName.trim(),
            vin:             vin.trim(),
            inspectionType:  inspectionType,
            ...(isOpsMode && {
              supervisorFiled: 'true',
              supervisorName:  opsSupervisor.trim(),
            }),
          },
          sessionType:  FileSystem.FileSystemSessionType.BACKGROUND,
        }
      );

      const response = JSON.parse(uploadResult.body);

      if (!response.success || !response.jobId) {
        throw new Error(response.error || 'Server rejected upload');
      }

      setJobId(response.jobId);
      setUploadProgress(100);
      setUploadMessage('✅ Received — processing in background...');

      // Poll job status
      pollJobStatus(response.jobId);

    } catch (err) {
      console.error('Upload error:', err);
      setIsUploading(false);
      Alert.alert(
        'Upload Failed',
        `${err.message}\n\nCheck your WiFi and tap Retry.`,
        [
          { text: 'Retry', onPress: () => uploadVideo(recordingUri) },
          { text: 'Cancel', style: 'cancel', onPress: () => setIsUploading(false) },
        ]
      );
    }
  };

  // ── Poll job status ───────────────────────────────────────────────────────
  const pollJobStatus = useCallback(async (jid) => {
    let attempts = 0;
    const maxAttempts = 150; // 5 min at 2s intervals

    const poll = async () => {
      if (attempts++ > maxAttempts) {
        setUploadMessage('Processing is taking longer than expected. Check back later.');
        return;
      }
      try {
        const res  = await fetch(ENDPOINTS.jobStatus(jid));
        const data = await res.json();

        if (data.status === 'complete') {
          setUploadProgress(100);
          setUploadMessage('✅ Submitted! You\'re done.');
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setTimeout(() => navigation.navigate('Success'), 1500);
          return;
        }

        if (data.status === 'failed') {
          setIsUploading(false);
          Alert.alert('Processing Failed', data.message || 'Upload failed. Contact fleet management.');
          return;
        }

        // Still processing — update message and poll again
        setUploadMessage(data.message || 'Processing...');
        if (data.progress) setUploadProgress(data.progress);
        setTimeout(poll, POLL_INTERVAL_MS);

      } catch (_) {
        setTimeout(poll, POLL_INTERVAL_MS * 2); // back off on network error
      }
    };

    setTimeout(poll, POLL_INTERVAL_MS);
  }, [navigation]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopTimer();
      if (cameraRef.current && isRecording) {
        cameraRef.current.stopRecording();
      }
    };
  }, [isRecording]);

  // ── Permission not yet granted ────────────────────────────────────────────
  if (!permission) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#3B82F6" size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centered}>
          <Text style={styles.permText}>Camera access is required for vehicle inspections.</Text>
          <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
            <Text style={styles.permBtnText}>Grant Camera Access</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      {/* Tow Modal */}
      <Modal visible={!!towModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modal, towModal === 'active' ? styles.modalBlue : styles.modalRed]}>
            <Text style={styles.modalIcon}>{towModal === 'active' ? '🚨' : '⚠️'}</Text>
            <Text style={[styles.modalTitle, { color: towModal === 'active' ? '#3B82F6' : '#EF4444' }]}>
              {towModal === 'active' ? 'Tow Assistance Active' : 'No Tow Assistance'}
            </Text>
            <Text style={styles.modalBody}>
              {towModal === 'active'
                ? 'Tow assistance is strictly limited to mechanical failures only.\n\n🚫 Avoid long driveways, dirt/gravel roads, and reckless driving.\n\n📞 Use call-text-call for difficult delivery locations.'
                : '🚫 This vehicle has NO tow assistance.\n\nAvoid long driveways, dirt/gravel roads, and reckless driving.\n\n📞 Use call-text-call for difficult delivery locations.\n\n💰 Driver is financially responsible for towing costs from violations.'}
            </Text>
            <TouchableOpacity
              style={[styles.modalBtn, { backgroundColor: towModal === 'active' ? '#3B82F6' : '#EF4444' }]}
              onPress={() => setTowModal(null)}
            >
              <Text style={styles.modalBtnText}>I Understand & Agree</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">

        {/* Back + Header */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.version}>v4.6.7</Text>
        </View>

        <Text style={styles.screenTitle}>Video Inspection</Text>
        <Text style={styles.timestamp}>{new Date().toLocaleString()}</Text>

        {/* Driver Name */}
        <View style={styles.formGroup}>
          <Text style={styles.label}>Driver Full Name</Text>
          <TextInput
            style={styles.input}
            value={driverName}
            onChangeText={(text) => {
              setDriverName(text);
              const ops = text.toUpperCase().includes('OPS');
              setIsOpsMode(ops);
              if (!ops) { setOpsDriverName(''); setOpsSupervisor(''); }
            }}
            placeholder="Enter Full Name"
            placeholderTextColor="#4B5563"
            autoCapitalize="words"
            editable={!isRecording && !isUploading}
          />

          {/* OPS Supervisor Mode Banner */}
          {isOpsMode && (
            <View style={styles.opsBanner}>
              <Text style={styles.opsTitle}>⚡ SUPERVISOR MODE — OPS DETECTED</Text>
              <Text style={styles.opsLabel}>Driver Being Submitted For</Text>
              <TextInput
                style={[styles.input, { marginBottom: 10 }]}
                value={opsDriverName}
                onChangeText={setOpsDriverName}
                placeholder="Enter driver's full name"
                placeholderTextColor="#4B5563"
                autoCapitalize="words"
                editable={!isRecording && !isUploading}
              />
              <Text style={styles.opsLabel}>Supervisor / Manager Name</Text>
              <TextInput
                style={styles.input}
                value={opsSupervisor}
                onChangeText={setOpsSupervisor}
                placeholder="Enter your name"
                placeholderTextColor="#4B5563"
                autoCapitalize="words"
                editable={!isRecording && !isUploading}
              />
            </View>
          )}
        </View>

        {/* VIN + Vehicle Type */}
        <View style={styles.row}>
          <View style={[styles.formGroup, { flex: 0.38 }]}>
            <Text style={styles.label}>Last 4 VIN</Text>
            <TextInput
              style={styles.input}
              value={vin}
              onChangeText={handleVinChange}
              placeholder="VIN"
              placeholderTextColor="#4B5563"
              maxLength={4}
              autoCapitalize="characters"
              keyboardType="default"
              editable={!isRecording && !isUploading}
            />
          </View>
          <View style={[styles.formGroup, { flex: 0.62, marginLeft: 8 }]}>
            <Text style={styles.label}>Vehicle Type</Text>
            <View style={[
              styles.input, styles.readonlyInput,
              vehicleFuel === 'electric' && styles.electricInput,
              vehicleFuel === 'diesel'   && styles.dieselInput,
              vehicleFuel === 'gas'      && styles.gasInput,
            ]}>
              <Text style={[
                styles.readonlyText,
                vehicleFuel === 'electric' && { color: '#FFFFFF' },
                vehicleFuel === 'diesel'   && { color: '#4ADE80' },
                vehicleFuel === 'gas'      && { color: '#EF4444' },
              ]} numberOfLines={2}>
                {vehicleType || 'Auto-Detect...'}
              </Text>
            </View>
          </View>
        </View>

        {/* Tow Status */}
        {hasTow !== null && (
          <View style={[styles.towStatus, hasTow ? styles.towActive : styles.towNone]}>
            <Text style={styles.towText}>
              {hasTow ? '🚛 Tow Assistance Active' : '🚫 No Tow Assistance'}
            </Text>
          </View>
        )}

        {/* Inspection Type */}
        <View style={styles.formGroup}>
          <Text style={styles.label}>Inspection Type</Text>
          <View style={styles.typeGrid}>
            {INSPECTION_TYPES.map(type => (
              <TouchableOpacity
                key={type}
                style={[styles.typeBtn, inspectionType === type && styles.typeBtnSelected]}
                onPress={() => { setInspectionType(type); setUserPickedType(true); }}
                disabled={isRecording || isUploading}
              >
                <Text style={[styles.typeBtnText, inspectionType === type && styles.typeBtnTextSelected]}>
                  {type}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Camera */}
        <View style={styles.cameraWrap}>
          <Camera
            ref={cameraRef}
            style={styles.camera}
            facing="back"
            mode="video"
          >
            {/* Timer overlay */}
            {isRecording && (
              <View style={styles.timerOverlay}>
                <Text style={styles.timerText}>{formatTime(seconds)}</Text>
              </View>
            )}

            {/* Record / Stop controls */}
            <View style={styles.controls}>
              {!isRecording && !recordingUri && !isUploading && (
                <TouchableOpacity style={styles.recBtn} onPress={startRecording}>
                  <Text style={styles.recBtnText}>REC</Text>
                </TouchableOpacity>
              )}
              {isRecording && (
                <TouchableOpacity style={[styles.recBtn, styles.stopBtn]} onPress={stopRecording}>
                  <View style={styles.stopSquare} />
                </TouchableOpacity>
              )}
            </View>
          </Camera>
        </View>

        {/* Upload progress */}
        {isUploading && (
          <View style={styles.uploadBox}>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${uploadProgress}%` }]} />
              <Text style={styles.progressPct}>{uploadProgress}%</Text>
            </View>
            <Text style={styles.uploadMsg}>{uploadMessage}</Text>
          </View>
        )}

        {/* Status */}
        {!isUploading && (
          <Text style={styles.status}>
            {isRecording
              ? '🔴 Recording... Walk around vehicle'
              : recordingUri
              ? '✅ Video ready — uploading...'
              : 'Ready for Inspection'}
          </Text>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  scroll: { flex: 1, paddingHorizontal: 20 },

  // Top bar
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, marginBottom: 8 },
  backBtn: { backgroundColor: '#1E88E5', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  backText: { color: '#FFF', fontWeight: '700', fontSize: 16 },
  version: { color: '#6B7280', fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase' },

  screenTitle: { color: '#3B82F6', fontSize: 24, fontWeight: '900', textAlign: 'center', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  timestamp:   { color: '#4ADE80', textAlign: 'center', fontSize: 12, fontWeight: '700', marginBottom: 20 },

  // Form
  formGroup: { marginBottom: 16 },
  label:     { color: '#3B82F6', fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  input: {
    backgroundColor: '#1C1C1E',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    color: '#FFFFFF',
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 48,
  },
  readonlyInput: { justifyContent: 'center', paddingVertical: 8 },
  readonlyText:  { color: '#6B7280', fontSize: 13, fontWeight: '700' },
  electricInput: { borderColor: '#FFFFFF' },
  dieselInput:   { borderColor: '#4ADE80' },
  gasInput:      { borderColor: '#EF4444' },
  row:           { flexDirection: 'row', marginBottom: 0 },

  // Tow status
  towStatus:  { borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, marginBottom: 16, alignItems: 'center' },
  towActive:  { backgroundColor: 'rgba(37,99,235,0.15)', borderWidth: 1, borderColor: '#2563EB' },
  towNone:    { backgroundColor: 'rgba(239,68,68,0.15)', borderWidth: 1, borderColor: '#EF4444' },
  towText:    { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },

  // Inspection type
  typeGrid:           { flexDirection: 'row', gap: 10 },
  typeBtn:            { flex: 1, borderWidth: 1, borderColor: '#374151', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  typeBtnSelected:    { backgroundColor: '#1976D2', borderColor: '#1976D2' },
  typeBtnText:        { color: '#6B7280', fontWeight: '800', fontSize: 14, textTransform: 'uppercase' },
  typeBtnTextSelected:{ color: '#FFFFFF' },

  // Camera
  cameraWrap: { borderRadius: 16, overflow: 'hidden', marginBottom: 16, height: 340, borderWidth: 1, borderColor: '#374151' },
  camera:     { flex: 1 },
  controls:   { position: 'absolute', bottom: 20, left: 0, right: 0, alignItems: 'center' },
  recBtn:     { width: 64, height: 64, borderRadius: 32, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)' },
  recBtnText: { color: '#FFF', fontWeight: '900', fontSize: 12 },
  stopBtn:    { backgroundColor: '#374151' },
  stopSquare: { width: 22, height: 22, backgroundColor: '#FFFFFF', borderRadius: 3 },
  timerOverlay: { position: 'absolute', top: 16, right: 16, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(239,68,68,0.5)' },
  timerText:    { color: '#EF4444', fontWeight: '900', fontSize: 18 },

  // Upload
  uploadBox:      { marginBottom: 16 },
  progressBarBg:  { height: 56, backgroundColor: '#1E293B', borderRadius: 14, borderWidth: 3, borderColor: '#22C55E', overflow: 'hidden', position: 'relative', justifyContent: 'center' },
  progressBarFill:{ position: 'absolute', top: 0, left: 0, bottom: 0, backgroundColor: '#22C55E', borderRadius: 12 },
  progressPct:    { color: '#FFFFFF', fontWeight: '900', fontSize: 22, textAlign: 'center', zIndex: 1 },
  uploadMsg:      { color: '#94A3B8', textAlign: 'center', marginTop: 8, fontSize: 13, fontWeight: '600' },

  status:  { color: '#94A3B8', textAlign: 'center', marginBottom: 40, fontSize: 14, fontWeight: '700', textTransform: 'uppercase' },

  // OPS mode
  opsBanner: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderWidth: 2,
    borderColor: '#F59E0B',
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
  },
  opsTitle: {
    color: '#F59E0B',
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  opsLabel: {
    color: '#F59E0B',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },

  // Permission
  permText:    { color: '#FFFFFF', textAlign: 'center', fontSize: 16, marginBottom: 24, lineHeight: 24 },
  permBtn:     { backgroundColor: '#3B82F6', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 },
  permBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },

  // Modals
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal:        { backgroundColor: '#1F2937', borderWidth: 2, borderRadius: 16, padding: 24, width: '100%', maxWidth: 400 },
  modalRed:     { borderColor: '#EF4444' },
  modalBlue:    { borderColor: '#2563EB' },
  modalIcon:    { fontSize: 40, textAlign: 'center', marginBottom: 12 },
  modalTitle:   { fontSize: 20, fontWeight: '900', textTransform: 'uppercase', textAlign: 'center', marginBottom: 16 },
  modalBody:    { color: '#E5E7EB', fontSize: 14, lineHeight: 22, marginBottom: 24 },
  modalBtn:     { paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  modalBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16, textTransform: 'uppercase' },
});
