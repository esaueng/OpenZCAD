import { afterEach, expect, it, vi } from 'vitest';
import { toUserId } from '@openzcad/shared';
import { restoreProjectInWorker } from './projectBackupWorkerClient';
import { MAX_PROJECT_BACKUP_BYTES } from './projectBackup';
class FakeWorker {
  static latest: FakeWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { FakeWorker.latest=this; }
}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('refuses oversized backup files before starting a parser',async()=>{
  const constructor=vi.fn();vi.stubGlobal('Worker',constructor);
  const file=new File(['{}'],'large.openzcad');Object.defineProperty(file,'size',{value:MAX_PROJECT_BACKUP_BYTES+1});
  await expect(restoreProjectInWorker(file,toUserId('user_restore'))).rejects.toThrow(/256 MB/);
  expect(constructor).not.toHaveBeenCalled();
});
it('terminates parsing on its deadline and ignores late replies',async()=>{
  vi.useFakeTimers();vi.stubGlobal('Worker',FakeWorker);
  const pending=restoreProjectInWorker(new File(['{}'],'project.openzcad'),toUserId('user_restore'));
  const rejected=expect(pending).rejects.toThrow(/120 second/);
  await vi.advanceTimersByTimeAsync(120_000);await rejected;
  FakeWorker.latest.onmessage?.({data:{ok:true,backup:{}}} as MessageEvent);
  expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce();
});
it('reports parser refusals and releases the worker',async()=>{
  vi.stubGlobal('Worker',FakeWorker);
  const pending=restoreProjectInWorker(new File(['{}'],'project.openzcad'),toUserId('user_restore'));
  FakeWorker.latest.onmessage?.({data:{ok:false,error:'Invalid backup'}} as MessageEvent);
  await expect(pending).rejects.toThrow('Invalid backup');
  expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce();
});
