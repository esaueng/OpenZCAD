import { describe, expect, it } from 'vitest';
import { MlsError } from './errors';
import { connectEngine, serveEngine } from './protocol';
import { MlsEngine } from './engine';
import { loadWasm } from './test-support';

describe('Worker protocol', () => {
  it('rejects pending and later requests once the Worker fails', async () => {
    const channel = new MessageChannel();
    channel.port2.start();
    const connection = connectEngine(channel.port2); // nobody serves port1
    const pending = connection.api.buildInfo();
    connection.fail('the MLS Worker failed');
    await expect(pending).rejects.toMatchObject({
      kind: 'worker',
      message: 'the MLS Worker failed'
    });
    await expect(connection.api.buildInfo()).rejects.toBeInstanceOf(MlsError);
    channel.port1.close();
    channel.port2.close();
  });

  it('carries policy errors, typed, across the boundary', async () => {
    const channel = new MessageChannel();
    serveEngine(channel.port1, Promise.resolve(new MlsEngine(loadWasm())));
    channel.port1.start();
    channel.port2.start();
    const { api } = connectEngine(channel.port2);
    const id = await api.generate({
      projectId: 'p',
      userId: 'u',
      deviceId: 'd'
    });
    await expect(api.createGroup(id, 16)).rejects.toMatchObject({
      kind: 'state'
    });
    await api.certify(id, new Uint8Array([1]));
    await expect(api.createGroup(id, 0)).rejects.toMatchObject({
      kind: 'policy',
      reasons: [expect.objectContaining({ code: 'roles-invalid' })]
    });
    await expect(api.status(999)).rejects.toMatchObject({ kind: 'state' });
    channel.port1.close();
    channel.port2.close();
  });
});
