import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import {
  init,
  effect,
  frame,
  surface,
  type Effect,
  type Surface,
  type Gpu,
} from 'vgpu';
import './AeroShards.css';

const hexToRgb = (hex: string): [number, number, number] => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255,
      ]
    : [0, 0, 0];
};

const SHADER = `
struct Uniforms {
  time: f32,
  resolution: vec2f,
  bgColor: vec4f,
  shardColor: vec4f,
  accentColor: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  let pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  return vec4f(pos[vertexIndex], 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / uniforms.resolution;
  
  let time = uniforms.time * 0.5;
  let pattern = sin(uv.x * 20.0 + time) * sin(uv.y * 20.0 - time);
  let gradient = smoothstep(0.0, 1.0, pattern * 0.5 + 0.5);
  
  let mixed = mix(uniforms.bgColor.rgb, uniforms.shardColor.rgb, gradient * 0.3);
  let accentMix = mix(mixed, uniforms.accentColor.rgb, sin(time + uv.x * 10.0) * 0.1 + 0.1);
  
  return vec4f(accentMix, 1.0);
}
`;

export interface AeroShardsProps {
  backgroundColor?: string;
  shardColor?: string;
  accentColor?: string;
  placement?: 'right' | 'left' | 'center' | 'full';
  flow?: 'stream' | 'vortex' | 'ribbon';
  material?: 'pearl' | 'chrome' | 'satin';
  detail?: 'bold' | 'balanced' | 'fine';
  scale?: number;
  spread?: number;
  depth?: number;
  speed?: number;
  spin?: number;
  interaction?: 'none' | 'repel' | 'attract';
  density?: number;
  shardSize?: number;
  stretch?: number;
  turbulence?: number;
  glow?: number;
  edgeSoftness?: number;
  bloom?: number;
  grain?: number;
  chromaticAberration?: number;
  transitionDuration?: number;
  interactionRadius?: number;
  interactionStrength?: number;
  rippleIntensity?: number;
  holdToGather?: boolean;
  paused?: boolean;
  className?: string;
  onError?: (error: Error) => void;
  style?: CSSProperties;
  children?: ReactNode;
}

export function AeroShards({
  backgroundColor = '#120F17',
  shardColor = '#896ABD',
  accentColor = '#A855F7',
  placement = 'full',
  flow = 'stream',
  material = 'pearl',
  detail = 'balanced',
  scale = 1,
  spread = 1,
  depth = 1,
  speed = 1,
  spin = 1,
  density = 1.5,
  shardSize = 1.1,
  stretch = 1,
  turbulence = 1,
  glow = 1,
  edgeSoftness = 2,
  bloom = 0.5,
  grain = 0.05,
  chromaticAberration = 0.0075,
  transitionDuration = 1,
  interactionRadius = 1.5,
  interactionStrength = 0.5,
  rippleIntensity = 1,
  holdToGather = true,
  paused = false,
  className = '',
  onError,
  style,
}: AeroShardsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpuRef = useRef<Gpu | null>(null);
  const effectInstanceRef = useRef<Effect | null>(null);
  const surfaceInstanceRef = useRef<Surface | null>(null);
  const animationRef = useRef<number | null>(null);
  const pausedRef = useRef(paused);
  const speedRef = useRef(speed);

  // Keep refs in sync with props
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    async function initGpu() {
      try {
        const gpuInstance = await init();

        if (!gpuInstance) {
          throw new Error('Failed to initialize WebGPU');
        }

        canvas.style.width = '100%';
        canvas.style.height = '100%';

        const surfaceInst = surface(gpuInstance, canvas, {
          dpr: [1, 2],
          alphaMode: 'premultiplied',
        });

        const effectInst = effect(gpuInstance, SHADER, {
          set: {
            time: 0,
            resolution: [window.innerWidth, window.innerHeight],
            bgColor: [...hexToRgb(backgroundColor), 1],
            shardColor: [...hexToRgb(shardColor), 1],
            accentColor: [...hexToRgb(accentColor), 1],
          },
        });

        gpuRef.current = gpuInstance;
        effectInstanceRef.current = effectInst;
        surfaceInstanceRef.current = surfaceInst;

        let lastTime = performance.now();

        const animate = () => {
          const currentTime = performance.now();
          const elapsed = (currentTime - lastTime) / 1000;
          lastTime = currentTime;

          const gpuInst = gpuRef.current;
          const effectInstRef = effectInstanceRef.current;
          const surfaceInstRef = surfaceInstanceRef.current;
          const isPaused = pausedRef.current;
          const currentSpeed = speedRef.current;

          if (!isPaused && gpuInst && effectInstRef && surfaceInstRef) {
            const timeValue = currentTime / 1000;

            effectInstRef.set({
              time: timeValue * currentSpeed,
              resolution: [container.clientWidth, container.clientHeight],
              bgColor: [...hexToRgb(backgroundColor), 1],
              shardColor: [...hexToRgb(shardColor), 1],
              accentColor: [...hexToRgb(accentColor), 1],
            });

            frame(gpuInst, (f) => f.pass(surfaceInstRef, effectInstRef));
          }

          animationRef.current = requestAnimationFrame(animate);
        };

        animationRef.current = requestAnimationFrame(animate);
      } catch (err) {
        console.error('WebGPU initialization failed:', err);
        if (onError) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    initGpu();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (gpuRef.current) {
        gpuRef.current.dispose();
        gpuRef.current = null;
      }
    };
  }, [backgroundColor, shardColor, accentColor, onError]);

  useEffect(() => {
    const effectInstRef = effectInstanceRef.current;
    if (effectInstRef && gpuRef.current) {
      effectInstRef.set({
        bgColor: [...hexToRgb(backgroundColor), 1],
        shardColor: [...hexToRgb(shardColor), 1],
        accentColor: [...hexToRgb(accentColor), 1],
      });
    }
  }, [backgroundColor, shardColor, accentColor]);

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  };

  return (
    <div
      ref={containerRef}
      className={`aeroshards-container ${className}`}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        ...style,
      }}
      onPointerMove={handlePointerMove}
    >
      <canvas ref={canvasRef} className="aeroshards-canvas" />
    </div>
  );
}

export default AeroShards;
