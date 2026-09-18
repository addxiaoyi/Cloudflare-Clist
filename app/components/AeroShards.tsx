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
  pointerPos: vec2f,
  pointerStrength: f32,
  scale: f32,
  hoverGlow: f32,
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
  
  // Calculate pointer distance
  let pointerUv = uniforms.pointerPos / uniforms.resolution;
  let rawDist = distance(uv, pointerUv);
  let dist = max(rawDist, 0.0001);
  
  // Create base animated pattern
  let patternScale = 20.0 * uniforms.scale;
  let pattern = sin(uv.x * patternScale + time) * 
                sin(uv.y * patternScale - time * 0.7);
  
  // Hover intensity factor
  let hoverIntensity = uniforms.pointerStrength * uniforms.hoverGlow;
  
  // Strong repulsion effect - pushes pattern away from cursor
  let repulsionStrength = 0.4 * hoverIntensity;
  let repulsionRadius = 0.25;
  let repulsionNorm = 1.0 - smoothstep(0.0, repulsionRadius, dist);
  let repulsion = repulsionNorm * repulsionStrength;
  
  // Ripple effect - concentric waves emanating from cursor
  let rippleSpeed = 1.5;
  let rippleWidth = 0.08;
  let rippleFreq = 8.0;
  let ripple = sin(rawDist * rippleFreq - time * rippleSpeed * hoverIntensity);
  let rippleEffect = smoothstep(rippleWidth, 0.0, abs(ripple)) * hoverIntensity;
  
  // Outer glow ring
  let outerGlowRadius = 0.18;
  let outerGlow = smoothstep(outerGlowRadius, 0.05, dist) * hoverIntensity;
  
  // Core bright glow
  let coreGlowRadius = 0.06;
  let coreGlow = smoothstep(coreGlowRadius, 0.0, dist) * hoverIntensity;
  
  // Combine effects
  let distortPattern = sin((uv.x + repulsion * 0.1) * patternScale + time) * 
                       sin((uv.y + repulsion * 0.1) * patternScale - time * 0.7);
  let gradient = smoothstep(0.0, 1.0, distortPattern * 0.5 + 0.5);
  
  // Base color mixing
  let mixed = mix(uniforms.bgColor.rgb, uniforms.shardColor.rgb, gradient * 0.3);
  
  // Time-based accent color pulse
  let accentPulse = sin(time * 2.0 + uv.x * 5.0) * 0.15 + 0.15;
  
  // Strong hover color shift
  let hoverColorShift = repulsion * 0.8 + rippleEffect * 0.5 + outerGlow * 0.6;
  let hoverAccentMix = mix(mixed, uniforms.accentColor.rgb * 1.2, hoverColorShift + accentPulse);
  
  // Final composition: core glow + outer glow + ripple highlight
  let finalGlow = coreGlow * vec3f(1.0, 0.95, 0.9) + 
                  outerGlow * vec3f(0.8, 0.6, 1.0) +
                  rippleEffect * vec3f(0.7, 0.5, 1.0);
  
  let finalColor = hoverAccentMix + finalGlow * 0.4;
  
  // Add vignette-like fade at edges
  let vignette = 1.0 - smoothstep(0.5, 1.0, length(uv * 0.5 + 0.5));
  
  return vec4f(finalColor * vignette, 1.0);
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
  interaction = 'repel',
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
  const scaleRef = useRef(scale);
  const interactionStrengthRef = useRef(interactionStrength);
  const rippleIntensityRef = useRef(rippleIntensity);
  const pointerPosRef = useRef({ x: 0, y: 0 });
  const pointerActiveRef = useRef(false);
  const hoverGlowRef = useRef(0);

  // Keep refs in sync with props
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { interactionStrengthRef.current = interactionStrength; }, [interactionStrength]);
  useEffect(() => { rippleIntensityRef.current = rippleIntensity; }, [rippleIntensity]);

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
            resolution: [container.clientWidth, container.clientHeight],
            bgColor: [...hexToRgb(backgroundColor), 1],
            shardColor: [...hexToRgb(shardColor), 1],
            accentColor: [...hexToRgb(accentColor), 1],
            pointerPos: [container.clientWidth / 2, container.clientHeight / 2],
            pointerStrength: 0,
            scale,
            hoverGlow: 0,
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
            const pointerActive = pointerActiveRef.current;
            const targetHoverGlow = pointerActive ? interactionStrengthRef.current * rippleIntensityRef.current : 0;
            
            // Smooth transition for hover glow
            hoverGlowRef.current += (targetHoverGlow - hoverGlowRef.current) * Math.min(elapsed * 8, 1);

            effectInstRef.set({
              time: timeValue * currentSpeed,
              resolution: [container.clientWidth, container.clientHeight],
              bgColor: [...hexToRgb(backgroundColor), 1],
              shardColor: [...hexToRgb(shardColor), 1],
              accentColor: [...hexToRgb(accentColor), 1],
              pointerPos: [pointerPosRef.current.x, pointerPosRef.current.y],
              pointerStrength: pointerActive ? interactionStrengthRef.current : 0,
              scale: scaleRef.current,
              hoverGlow: hoverGlowRef.current,
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
  }, [backgroundColor, shardColor, accentColor, scale, onError]);

  useEffect(() => {
    const effectInstRef = effectInstanceRef.current;
    if (effectInstRef && gpuRef.current) {
      effectInstRef.set({
        bgColor: [...hexToRgb(backgroundColor), 1],
        shardColor: [...hexToRgb(shardColor), 1],
        accentColor: [...hexToRgb(accentColor), 1],
        scale,
      });
    }
  }, [backgroundColor, shardColor, accentColor, scale]);

  const handlePointerMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    pointerPosRef.current = { x, y };
  };

  const handleMouseEnter = () => {
    pointerActiveRef.current = true;
  };

  const handleMouseLeave = () => {
    pointerActiveRef.current = false;
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
        cursor: 'none',
        ...style,
      }}
      onMouseMove={handlePointerMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <canvas ref={canvasRef} className="aeroshards-canvas" />
    </div>
  );
}

export default AeroShards;