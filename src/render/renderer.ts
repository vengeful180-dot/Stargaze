// WebGL renderer + post chain (bloom -> grade). HDR half-float buffers, optional MSAA.
import { BloomEffect, BlendFunction, EffectComposer, EffectPass, RenderPass } from 'postprocessing';
import * as THREE from 'three';
import type { QualityPreset } from '../core/settings';
import { GradeEffect } from './grade';
import { WarpEffect } from './warp';

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly bloom: BloomEffect;
  readonly grade: GradeEffect;
  readonly warp: WarpEffect;
  private renderPass: RenderPass;
  private effectPass: EffectPass;
  private preset: QualityPreset;
  private width = 1;
  private height = 1;

  constructor(
    readonly canvas: HTMLCanvasElement,
    preset: QualityPreset,
    readonly scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
  ) {
    this.preset = preset;
    const gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      stencil: false,
      depth: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: new URLSearchParams(location.search).has('test'),
    });
    if (!gl.capabilities.isWebGL2) throw new Error('WebGL 2 is not available');
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.NoToneMapping;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.autoClear = false;
    this.gl = gl;

    this.composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: preset.msaa });
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      mipmapBlur: true,
      luminanceThreshold: 0.9,
      luminanceSmoothing: 0.35,
      intensity: 0.85,
      radius: 0.72,
      levels: preset.bloomLevels,
    });
    this.grade = new GradeEffect();
    this.warp = new WarpEffect();
    this.effectPass = new EffectPass(camera, this.warp, this.bloom, this.grade);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.effectPass);
  }

  setQuality(preset: QualityPreset) {
    this.preset = preset;
    this.composer.multisampling = preset.msaa;
    this.bloom.mipmapBlurPass.levels = preset.bloomLevels;
    this.resize(this.width, this.height);
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    const pr = Math.min(window.devicePixelRatio || 1, this.preset.pixelRatio);
    this.gl.setPixelRatio(pr);
    this.gl.setSize(width, height, false);
    this.composer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  render(dt: number) {
    this.composer.render(dt);
  }

  get drawingSize(): THREE.Vector2 {
    return this.gl.getDrawingBufferSize(new THREE.Vector2());
  }
}
