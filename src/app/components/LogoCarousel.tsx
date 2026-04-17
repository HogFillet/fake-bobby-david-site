'use client'

import { useRef, useMemo, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'

const RADIUS = 1.5
const CARD_W = 2.0
const DEPTH = 0.45

// ── Shaders (same iridescent/bump shader as before) ──────────────────────────

const vertexShader = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vModelNormal;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;

  void main() {
    vUv = uv;
    vLocalPos = position;
    vModelNormal = normal;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
  }
`

const fragmentShader = /* glsl */`
  uniform sampler2D uTexture;
  uniform float uTime;
  uniform float uCardW;
  uniform float uCardH;
  uniform vec2 uTexSize;

  varying vec3 vNormal;
  varying vec3 vModelNormal;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;

  vec3 hue2rgb(float h) {
    h = fract(h);
    float r = abs(h * 6.0 - 3.0) - 1.0;
    float g = 2.0 - abs(h * 6.0 - 2.0);
    float b = 2.0 - abs(h * 6.0 - 4.0);
    return clamp(vec3(r, g, b), 0.0, 1.0);
  }

  vec3 alphaBumpNormal(vec3 baseN, vec2 uv, float bumpScale) {
    vec2 step = 3.0 / uTexSize;
    float aR = texture2D(uTexture, uv + vec2( step.x, 0.0)).a;
    float aL = texture2D(uTexture, uv + vec2(-step.x, 0.0)).a;
    float aU = texture2D(uTexture, uv + vec2(0.0,  step.y)).a;
    float aD = texture2D(uTexture, uv + vec2(0.0, -step.y)).a;
    vec2 grad = vec2(aR - aL, aU - aD);
    return normalize(baseN + vec3(-grad.x, -grad.y, 0.0) * bumpScale);
  }

  void main() {
    vec3 n  = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 mn = normalize(vModelNormal);

    float px = clamp((vLocalPos.x / uCardW) + 0.5, 0.0, 1.0);
    float py = clamp((vLocalPos.y / uCardH) + 0.5, 0.0, 1.0);

    float fresnel = 1.0 - max(dot(n, normalize(vViewDir)), 0.0);
    fresnel = pow(fresnel, 1.5);

    float hue = fresnel * 0.7 + uTime * 0.08;
    vec3 irid = hue2rgb(hue);
    float shimmer = sin(px * 15.0 + uTime * 2.0) * sin(py * 15.0 - uTime * 1.5);
    shimmer = shimmer * 0.5 + 0.5;
    vec3 glassColor = irid * (fresnel * 0.6 + shimmer * 0.2);
    float glassAlpha = fresnel * 0.35 + shimmer * 0.05;

    if (mn.z > 0.5) {
      vec2 uv = vec2(px, py);
      vec4 tex = texture2D(uTexture, uv);
      vec3 bumpN = alphaBumpNormal(n, uv, 1.4);
      float bFresnel = 1.0 - max(dot(bumpN, normalize(vViewDir)), 0.0);
      bFresnel = pow(bFresnel, 1.5);
      vec3 iridB = hue2rgb(bFresnel * 0.7 + uTime * 0.08);
      float edgeLight = max(dot(bumpN, normalize(vec3(1.0, 1.0, 2.0))), 0.0);
      vec3 logoColor = tex.rgb
          + iridB * bFresnel * 0.4
          + iridB * shimmer * bFresnel * 0.1
          + vec3(edgeLight * 0.25 * tex.a);
      vec3 color = mix(glassColor, logoColor, tex.a);
      gl_FragColor = vec4(color, max(tex.a, glassAlpha));

    } else if (mn.z < -0.5) {
      vec2 uv = vec2(px, py);
      vec4 tex = texture2D(uTexture, uv);
      vec3 bumpN = alphaBumpNormal(n, uv, 1.4);
      float bFresnel = 1.0 - max(dot(bumpN, normalize(vViewDir)), 0.0);
      bFresnel = pow(bFresnel, 1.5);
      vec3 iridB = hue2rgb(bFresnel * 0.7 + uTime * 0.08);
      float edgeLight = max(dot(bumpN, normalize(vec3(-1.0, 1.0, 2.0))), 0.0);
      vec3 logoColor = tex.rgb
          + iridB * bFresnel * 0.4
          + iridB * shimmer * bFresnel * 0.1
          + vec3(edgeLight * 0.25 * tex.a);
      vec3 color = mix(glassColor, logoColor, tex.a);
      gl_FragColor = vec4(color, max(tex.a, glassAlpha));

    } else {
      float dRight  = 1.0 - px;
      float dLeft   = px;
      float dTop    = 1.0 - py;
      float dBottom = py;
      vec2 sampleUV;
      if (dRight <= dLeft && dRight <= dTop && dRight <= dBottom)
        sampleUV = vec2(0.97, py);
      else if (dLeft <= dRight && dLeft <= dTop && dLeft <= dBottom)
        sampleUV = vec2(0.03, py);
      else if (dTop <= dRight && dTop <= dLeft && dTop <= dBottom)
        sampleUV = vec2(px, 0.97);
      else
        sampleUV = vec2(px, 0.03);
      vec4 edgeSample = texture2D(uTexture, sampleUV);
      vec3 edgeCol = edgeSample.rgb * 0.65 + vec3(fresnel * 0.3);
      vec3 col = mix(glassColor, edgeCol, edgeSample.a);
      gl_FragColor = vec4(col, max(edgeSample.a, glassAlpha * 0.5));
    }
  }
`

// ── Single card at a fixed position/angle in the carousel ────────────────────

function Card({ texture, angle }: { texture: THREE.Texture; angle: number }) {
  const matRef = useRef<THREE.ShaderMaterial | null>(null)

  const h = CARD_W / (texture.image.width / texture.image.height)

  const geometry = useMemo(() => {
    const r = Math.min(h * 0.18, 0.18)
    const shape = new THREE.Shape()
    shape.moveTo(-CARD_W / 2 + r, -h / 2)
    shape.lineTo(CARD_W / 2 - r, -h / 2)
    shape.quadraticCurveTo(CARD_W / 2, -h / 2, CARD_W / 2, -h / 2 + r)
    shape.lineTo(CARD_W / 2, h / 2 - r)
    shape.quadraticCurveTo(CARD_W / 2, h / 2, CARD_W / 2 - r, h / 2)
    shape.lineTo(-CARD_W / 2 + r, h / 2)
    shape.quadraticCurveTo(-CARD_W / 2, h / 2, -CARD_W / 2, h / 2 - r)
    shape.lineTo(-CARD_W / 2, -h / 2 + r)
    shape.quadraticCurveTo(-CARD_W / 2, -h / 2, -CARD_W / 2 + r, -h / 2)
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: DEPTH,
      bevelEnabled: false,
      curveSegments: 16,
    })
    geom.translate(0, 0, -DEPTH / 2)
    return geom
  }, [h])

  const material = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: texture },
        uTime: { value: 0 },
        uCardW: { value: CARD_W },
        uCardH: { value: h },
        uTexSize: { value: new THREE.Vector2(texture.image.width, texture.image.height) },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
    })
    matRef.current = mat
    return mat
  }, [texture, h])

  useFrame(({ clock }) => {
    if (matRef.current) matRef.current.uniforms.uTime.value = clock.getElapsedTime()
  })

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[Math.sin(angle) * RADIUS, 0, Math.cos(angle) * RADIUS]}
      rotation={[0, angle, 0]}
    />
  )
}

// ── Carousel group: auto-spin + drag ─────────────────────────────────────────

export default function LogoCarousel() {
  const textures = useTexture([
    '/images/fake-bobby-logo.png',
    '/images/fake-david-logo.png',
    '/images/fake-tommy-logo.png',
  ])

  const groupRef = useRef<THREE.Group>(null)
  const drag = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    rotY: 0,
    rotX: 0,
    dragStartRotY: 0,
    dragStartRotX: 0,
  })

  const { gl } = useThree()

  useEffect(() => {
    const canvas = gl.domElement
    const d = drag.current

    const onDown = (e: PointerEvent) => {
      d.isDragging = true
      d.startX = e.clientX
      d.startY = e.clientY
      d.dragStartRotY = d.rotY
      d.dragStartRotX = d.rotX
      canvas.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!d.isDragging) return
      d.rotY = d.dragStartRotY + (e.clientX - d.startX) * 0.007
      d.rotX = d.dragStartRotX + (e.clientY - d.startY) * 0.007
    }
    const onUp = () => { d.isDragging = false }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [gl])

  useFrame(() => {
    if (!groupRef.current) return
    const d = drag.current
    if (!d.isDragging) d.rotY += 0.008
    groupRef.current.rotation.y = d.rotY
    groupRef.current.rotation.x = d.rotX
  })

  return (
    <group ref={groupRef}>
      {textures.map((tex, i) => (
        <Card key={i} texture={tex} angle={(i / 3) * Math.PI * 2} />
      ))}
    </group>
  )
}
