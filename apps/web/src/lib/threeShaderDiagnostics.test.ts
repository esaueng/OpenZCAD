import type { WebGLRenderer } from 'three';
import { WebGLProgram as ThreeWebGLProgram } from 'three/src/renderers/webgl/WebGLProgram.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

function fixture(linked = true, programLog = '') {
  const handle = {} as WebGLProgram;
  const shaders: WebGLShader[] = [];
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86,
    ACTIVE_ATTRIBUTES: 0x8b89,
    createProgram: () => handle,
    createShader: () => {
      const shader = {} as WebGLShader;
      shaders.push(shader);
      return shader;
    },
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    deleteShader: vi.fn(),
    getProgramParameter: vi.fn((_program: WebGLProgram, name: number) =>
      name === 0x8b82 ? linked : 0
    ),
    getProgramInfoLog: vi.fn(() => programLog),
    getShaderInfoLog: vi.fn(() => 'ERROR: 0:1: diagnostic detail'),
    getShaderSource: vi.fn(() => 'void main() {}'),
    getShaderParameter: vi.fn(() => false),
    getError: () => 0
  };
  const onShaderError = vi.fn();
  const renderer = {
    getContext: () => gl,
    debug: {
      checkShaderErrors: true,
      onShaderError,
      checkShaderWarnings: undefined as boolean | undefined
    }
  };
  const program = new ThreeWebGLProgram(
    renderer as unknown as WebGLRenderer,
    'diagnostics-regression',
    {
      isRawShaderMaterial: true,
      shaderType: 'RawShaderMaterial',
      shaderName: 'DiagnosticsRegression',
      defines: {},
      envMapCubeUVHeight: null,
      vertexShader: 'void main() { gl_Position = vec4(0.0); }',
      fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }'
    }
  );
  return { gl, handle, shaders, renderer, program, onShaderError };
}

afterEach(() => vi.restoreAllMocks());

describe('patched Three shader diagnostics', () => {
  it('checks clean links once without synchronous individual shader-log queries', () => {
    const f = fixture();
    f.program.getUniforms();
    f.program.getAttributes();
    expect(f.gl.getProgramInfoLog).toHaveBeenCalledExactlyOnceWith(f.handle);
    expect(
      f.gl.getProgramParameter.mock.calls.filter(
        ([, name]) => name === f.gl.LINK_STATUS
      )
    ).toHaveLength(1);
    expect(f.gl.getShaderInfoLog).not.toHaveBeenCalled();
    expect(f.onShaderError).not.toHaveBeenCalled();
    expect(f.renderer.debug.checkShaderErrors).toBe(true);
  });

  it('retains shader details and the custom callback for failed links', () => {
    const f = fixture(false, 'link failure');
    f.renderer.debug.checkShaderWarnings = false;
    f.program.getUniforms();
    expect(f.gl.getShaderInfoLog).toHaveBeenCalledTimes(2);
    expect(f.onShaderError).toHaveBeenCalledExactlyOnceWith(
      f.gl,
      f.handle,
      f.shaders[0],
      f.shaders[1]
    );
  });

  it('still reports default shader errors with their source details', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const f = fixture(false, 'link failure');
    f.renderer.debug.checkShaderWarnings = false;
    Reflect.deleteProperty(f.renderer.debug, 'onShaderError');
    f.program.getUniforms();
    expect(error.mock.calls.flat().join(' ')).toContain('diagnostic detail');
    expect(f.gl.getShaderSource).toHaveBeenCalledTimes(2);
  });

  it('retains successful program warnings and their individual shader details', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = fixture(true, 'program warning');
    f.program.getUniforms();
    expect(warn.mock.calls.flat().join(' ')).toContain('program warning');
    expect(f.gl.getShaderInfoLog).toHaveBeenCalledTimes(2);
    expect(f.onShaderError).not.toHaveBeenCalled();
  });

  it('can skip successful warning queries while still validating the link', () => {
    const f = fixture();
    f.renderer.debug.checkShaderWarnings = false;
    f.program.getUniforms();
    expect(f.gl.getProgramParameter).toHaveBeenCalledWith(
      f.handle,
      f.gl.LINK_STATUS
    );
    expect(f.gl.getProgramInfoLog).not.toHaveBeenCalled();
    expect(f.gl.getShaderInfoLog).not.toHaveBeenCalled();
    expect(f.renderer.debug.checkShaderErrors).toBe(true);
  });
});
