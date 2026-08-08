import { useEffect, useRef } from 'react';
import type {
  Measurement,
  MeasurementDisplayOptions
} from '../lib/measurements';
import {
  buildMeasurementRecord,
  type StoredMeasurementRecord
} from '../lib/measurementRecord';
import {
  measurementRecordContentKey,
  projectMeasurementCloudApi,
  watchProjectMeasurements,
  type ProjectMeasurementWatcher
} from '../lib/measurementCloudSync';

export interface MeasurementCloudSyncAgentProps {
  projectId: string;
  measurements: readonly Measurement[];
  display: MeasurementDisplayOptions;
  setMeasurements(measurements: Measurement[]): void;
  setUnit(unit: MeasurementDisplayOptions['unit']): void;
  setPrecision(precision: number): void;
  setRadialDisplay(display: MeasurementDisplayOptions['radialDisplay']): void;
  loadLocal(projectId: string): Promise<StoredMeasurementRecord | null>;
  saveLocal(record: StoredMeasurementRecord): Promise<void>;
}

/** Cloud-only sidecar; rendering and local IndexedDB remain usable without it. */
export function MeasurementCloudSyncAgent({
  projectId,
  measurements,
  display,
  setMeasurements,
  setUnit,
  setPrecision,
  setRadialDisplay,
  loadLocal,
  saveLocal
}: MeasurementCloudSyncAgentProps) {
  const draft = buildMeasurementRecord(projectId, measurements, display, '');
  const contentKey = measurementRecordContentKey(draft);
  const contentKeyRef = useRef(contentKey);
  const recordRef = useRef<StoredMeasurementRecord>({
    ...draft,
    updatedAt: new Date().toISOString()
  });
  const changedRef = useRef(false);
  const watcherRef = useRef<ProjectMeasurementWatcher | null>(null);
  const applyCloudRecordRef = useRef((record: StoredMeasurementRecord) => {
    setMeasurements(record.measurements);
    setUnit(record.display.unit);
    setPrecision(record.display.precision);
    setRadialDisplay(record.display.radialDisplay);
  });
  applyCloudRecordRef.current = (record) => {
    setMeasurements(record.measurements);
    setUnit(record.display.unit);
    setPrecision(record.display.precision);
    setRadialDisplay(record.display.radialDisplay);
  };
  if (contentKeyRef.current !== contentKey) {
    contentKeyRef.current = contentKey;
    recordRef.current = { ...draft, updatedAt: new Date().toISOString() };
    changedRef.current = true;
  }

  useEffect(() => {
    const watcher = watchProjectMeasurements({
      api: projectMeasurementCloudApi,
      projectId,
      loadLocal: async () => {
        const local = await loadLocal(projectId);
        if (
          local &&
          measurementRecordContentKey(local) === contentKeyRef.current
        ) {
          recordRef.current = local;
        }
        return local;
      },
      saveLocal,
      onResult: (result) => {
        if (!result.record) return;
        const cloudKey = measurementRecordContentKey(result.record);
        if (cloudKey === contentKeyRef.current) {
          changedRef.current = false;
          recordRef.current = result.record;
          return;
        }
        if (
          changedRef.current &&
          Date.parse(recordRef.current.updatedAt) >
            Date.parse(result.record.updatedAt)
        ) {
          watcherRef.current?.push(recordRef.current);
          return;
        }
        changedRef.current = false;
        contentKeyRef.current = cloudKey;
        recordRef.current = result.record;
        applyCloudRecordRef.current(result.record);
      }
    });
    watcherRef.current = watcher;
    return () => {
      watcher.stop();
      watcherRef.current = null;
    };
  }, [loadLocal, projectId, saveLocal]);

  useEffect(() => {
    if (changedRef.current) watcherRef.current?.push(recordRef.current);
  }, [contentKey]);
  return null;
}
