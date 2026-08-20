import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Line } from "@react-three/drei";
import * as THREE from "three";

/* ---------- soft radial glow sprite texture (built once, shared) ---------- */
function useGlowTexture() {
  return useMemo(() => {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }, []);
}

/* ---------- undulating wireframe terrain (a stylised map of farmland) ---------- */
function TerrainGrid() {
  const meshRef = useRef();
  const geo = useMemo(() => new THREE.PlaneGeometry(36, 36, 26, 26), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = Math.sin(x * 0.22 + t * 0.15) * 0.4 + Math.cos(y * 0.26 + t * 0.12) * 0.35;
      pos.setZ(i, z);
    }
    pos.needsUpdate = true;
  });

  return (
    <mesh ref={meshRef} geometry={geo} rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.7, 0]}>
      <meshBasicMaterial color="#345c42" wireframe transparent opacity={0.32} />
    </mesh>
  );
}

/* ---------- equipment nodes scattered on the grid ---------- */
function Node({ d, glowTex }) {
  const ref = useRef();
  const color = d.isMatch ? "#e8b34a" : "#7fa6c9";

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (!ref.current) return;
    ref.current.position.y = d.y + Math.sin(t * 0.8 + d.phase) * 0.22;
    const pulse = d.isMatch ? 1 + Math.sin(t * 2.2 + d.phase) * 0.28 : 1;
    ref.current.scale.setScalar(pulse);
  });

  return (
    <group position={[d.x, d.y, d.z]} ref={ref}>
      <mesh>
        <sphereGeometry args={[d.isMatch ? 0.15 : 0.09, 10, 10]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <sprite scale={d.isMatch ? [1.7, 1.7, 1] : [1, 1, 1]}>
        <spriteMaterial
          map={glowTex}
          color={color}
          transparent
          opacity={0.55}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </sprite>
    </group>
  );
}

function Nodes({ data, glowTex }) {
  return (
    <group>
      {data.map((d, i) => (
        <Node key={i} d={d} glowTex={glowTex} />
      ))}
    </group>
  );
}

/* ---------- light beams: matched nodes pulse a signal toward the core ---------- */
function Beam({ node }) {
  const pulseRef = useRef();
  const speed = useMemo(() => 0.22 + Math.random() * 0.14, []);
  const phase = useMemo(() => Math.random(), []);

  const { points, curve } = useMemo(() => {
    const start = new THREE.Vector3(node.x, node.y, node.z);
    const end = new THREE.Vector3(0, 0.4, 0);
    const mid = start.clone().add(end).multiplyScalar(0.5).add(new THREE.Vector3(0, 2.4, 0));
    const c = new THREE.QuadraticBezierCurve3(start, mid, end);
    return { points: c.getPoints(28), curve: c };
  }, [node]);

  useFrame((state) => {
    const t = (state.clock.elapsedTime * speed + phase) % 1;
    const p = curve.getPoint(t);
    if (pulseRef.current) {
      pulseRef.current.position.copy(p);
      pulseRef.current.material.opacity = 0.9 * Math.sin(t * Math.PI);
    }
  });

  return (
    <group>
      <Line points={points} color="#e8b34a" transparent opacity={0.16} lineWidth={1} />
      <mesh ref={pulseRef}>
        <sphereGeometry args={[0.07, 8, 8]} />
        <meshBasicMaterial color="#f3c162" toneMapped={false} transparent opacity={0.9} />
      </mesh>
    </group>
  );
}

function Beams({ data }) {
  return (
    <group>
      {data.map((n, i) => (
        <Beam key={i} node={n} />
      ))}
    </group>
  );
}

/* ---------- expanding radar rings under the core ---------- */
function Rings() {
  const count = 3;
  const refs = useRef([]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    for (let i = 0; i < count; i++) {
      const local = (t * 0.3 + i / count) % 1;
      const ref = refs.current[i];
      if (!ref) continue;
      const scale = 0.7 + local * 8;
      ref.scale.set(scale, scale, scale);
      ref.material.opacity = Math.max(0, 0.35 * (1 - local));
    }
  });
  return (
    <>
      {new Array(count).fill(0).map((_, i) => (
        <mesh key={i} ref={(el) => (refs.current[i] = el)} rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.55, 0]}>
          <ringGeometry args={[0.92, 1, 56]} />
          <meshBasicMaterial color="#e8b34a" transparent opacity={0.3} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

/* ---------- the rotating "match core" — where all signals converge ---------- */
function MatchCore() {
  const outerRef = useRef();
  const innerRef = useRef();

  useFrame((state, delta) => {
    if (outerRef.current) {
      outerRef.current.rotation.y += delta * 0.28;
      outerRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.3) * 0.15;
    }
    if (innerRef.current) {
      innerRef.current.rotation.y -= delta * 0.45;
    }
  });

  return (
    <group position={[0, 0.4, 0]}>
      <mesh ref={outerRef}>
        <icosahedronGeometry args={[0.85, 0]} />
        <meshStandardMaterial color="#e8b34a" wireframe emissive="#e8b34a" emissiveIntensity={0.7} />
      </mesh>
      <mesh ref={innerRef}>
        <icosahedronGeometry args={[0.5, 1]} />
        <meshBasicMaterial color="#0e1f17" />
      </mesh>
      <pointLight color="#e8b34a" intensity={2.2} distance={8} />
      <Rings />
    </group>
  );
}

/* ---------- ambient drifting light motes ---------- */
function Fireflies({ count = 90 }) {
  const ref = useRef();
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 32;
      arr[i * 3 + 1] = Math.random() * 7 - 1.5;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 32;
    }
    return arr;
  }, [count]);
  const speeds = useMemo(() => new Array(count).fill(0).map(() => 0.04 + Math.random() * 0.07), [count]);

  useFrame(() => {
    const pos = ref.current.geometry.attributes.position;
    for (let i = 0; i < count; i++) {
      let y = pos.getY(i) + speeds[i] * 0.02;
      if (y > 5.5) y = -1.5;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#e8b34a" size={0.05} transparent opacity={0.45} sizeAttenuation />
    </points>
  );
}

function Scene({ interactive }) {
  const glowTex = useGlowTexture();

  const nodeData = useMemo(() => {
    const count = 20;
    return new Array(count).fill(0).map((_, i) => {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const radius = 6 + Math.random() * 8;
      return {
        x: Math.cos(angle) * radius,
        y: Math.random() * 1.4,
        z: Math.sin(angle) * radius,
        isMatch: i % 4 === 0,
        phase: Math.random() * Math.PI * 2,
      };
    });
  }, []);

  const matched = useMemo(() => nodeData.filter((n) => n.isMatch), [nodeData]);

  return (
    <>
      <color attach="background" args={["#0e1f17"]} />
      <fog attach="fog" args={["#0e1f17", 15, 32]} />
      <ambientLight intensity={0.45} color="#8fb79a" />
      <hemisphereLight args={["#7fa6c9", "#0e1f17", 0.35]} />
      <TerrainGrid />
      <Nodes data={nodeData} glowTex={glowTex} />
      <Beams data={matched} />
      <MatchCore />
      <Fireflies />
      <OrbitControls
        autoRotate
        autoRotateSpeed={0.55}
        enableZoom={false}
        enablePan={false}
        enableRotate={interactive}
        minPolarAngle={Math.PI / 3.3}
        maxPolarAngle={Math.PI / 2.15}
      />
    </>
  );
}

export default function FieldScene({ className = "", interactive = true, cameraDistance = 16 }) {
  return (
    <div className={className}>
      <Canvas
        dpr={[1, 1.6]}
        camera={{ position: [cameraDistance * 0.55, cameraDistance * 0.4, cameraDistance * 0.85], fov: 42 }}
        gl={{ antialias: true }}
      >
        <Suspense fallback={null}>
          <Scene interactive={interactive} />
        </Suspense>
      </Canvas>
    </div>
  );
}
