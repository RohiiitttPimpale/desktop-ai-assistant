import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'

const EMOTION_PRESETS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed'] as const

interface ArmPose {
  side: 'left' | 'right'
  node: THREE.Object3D
  baseZ: number
}

export class Avatar {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)

  private vrm: VRM | null = null
  private placeholder: THREE.Mesh | null = null
  private arms: ArmPose[] = []
  private lookAtTarget = new THREE.Object3D()

  private activeEmotion = 'neutral'
  private emotionWeights: Record<string, number> = {
    neutral: 1,
    happy: 0,
    sad: 0,
    angry: 0,
    surprised: 0,
    relaxed: 0
  }

  private gesture: { name: string; until: number } = { name: 'none', until: 0 }
  private speaking = false
  private targetMouth = 0
  private currentMouth = 0

  private targetLookX = 0
  private targetLookY = 0
  private currentLookX = 0
  private currentLookY = 0

  private nextBlinkAt = 2.5
  private blinkStartAt = -1
  private readonly blinkDuration = 0.14

  private bounds = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.3), new THREE.Vector3(0.5, 1.7, 0.3))

  // Reused scratch vector: avoids a new Vector3 allocation every frame (GC pressure)
  private readonly scratchHeadPos = new THREE.Vector3()

  constructor() {
    const key = new THREE.DirectionalLight(0xffffff, Math.PI)
    key.position.set(0.8, 1, 1).normalize()
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.35), this.lookAtTarget)
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(height, 1)
    this.camera.updateProjectionMatrix()
    this.frame()
  }

  async load(buffer: ArrayBuffer): Promise<void> {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.parseAsync(buffer, '')
    const vrm = gltf.userData.vrm as VRM | undefined
    if (!vrm) throw new Error('This file is not a VRM model.')

    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.rotateVRM0(vrm)
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false
    })

    this.clear()
    this.scene.add(vrm.scene)
    this.vrm = vrm

    if (vrm.lookAt) {
      vrm.lookAt.target = this.lookAtTarget
    }

    this.relaxArms(vrm)
    vrm.update(0)
    vrm.scene.updateMatrixWorld(true)
    this.bounds = new THREE.Box3().setFromObject(vrm.scene, true)
    this.frame()
  }

  showPlaceholder(): void {
    this.clear()
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.5, 3),
      new THREE.MeshStandardMaterial({ color: 0x8b5cf6, roughness: 0.35, metalness: 0.1, emissive: 0x2e1065 })
    )
    this.scene.add(mesh)
    this.placeholder = mesh
    this.bounds = new THREE.Box3(new THREE.Vector3(-0.6, -0.6, -0.6), new THREE.Vector3(0.6, 0.6, 0.6))
    this.frame()
  }

  setReaction(emotion: string, gesture: string): void {
    this.activeEmotion = EMOTION_PRESETS.includes(emotion as any) ? emotion : 'neutral'
    this.gesture = { name: gesture, until: performance.now() / 1000 + 2.2 }
  }

  setSpeaking(active: boolean): void {
    this.speaking = active
    if (!active) this.targetMouth = 0
  }

  setMouthVolume(level: number): void {
    this.targetMouth = Math.min(1, Math.max(0, level))
  }

  /** nx, ny in [-1, 1] relative to the overlay window center */
  setLookTarget(nx: number, ny: number): void {
    this.targetLookX = Math.max(-1, Math.min(1, nx))
    this.targetLookY = Math.max(-1, Math.min(1, ny))
  }

  update(delta: number, elapsed: number): void {
    // 1. Smoothly damp cursor look-at coordinates
    const lookFollow = Math.min(1, delta * 8)
    this.currentLookX += (this.targetLookX - this.currentLookX) * lookFollow
    this.currentLookY += (this.targetLookY - this.currentLookY) * lookFollow

    // 2. Smoothly damp lip-sync volume
    const desiredMouth = this.speaking
      ? this.targetMouth > 0.01
        ? this.targetMouth
        : (Math.sin(elapsed * 18) + 1) * 0.3
      : 0
    this.currentMouth += (desiredMouth - this.currentMouth) * 0.35

    // 3. Auto-return to neutral expression 6s after gesture finishes and not speaking
    if (!this.speaking && elapsed > this.gesture.until + 6.0 && this.activeEmotion !== 'neutral') {
      this.activeEmotion = 'neutral'
    }

    if (this.vrm) {
      const humanoid = this.vrm.humanoid
      const chest = humanoid.getNormalizedBoneNode('chest') ?? humanoid.getNormalizedBoneNode('spine')
      if (chest) {
        chest.rotation.x = Math.sin(elapsed * 1.8) * 0.018
        chest.rotation.z = Math.sin(elapsed * 0.9) * 0.01
      }

      const neck = humanoid.getNormalizedBoneNode('neck')
      if (neck) {
        neck.rotation.y = this.currentLookX * 0.15
        neck.rotation.x = this.currentLookY * 0.12
      }

      const head = humanoid.getNormalizedBoneNode('head')
      if (head) {
        const gestureActive = elapsed < this.gesture.until
        let targetHeadX = this.currentLookY * 0.22
        let targetHeadY = this.currentLookX * 0.28 + Math.sin(elapsed * 0.6) * 0.04
        let targetHeadZ = 0

        if (gestureActive && this.gesture.name === 'nod') {
          targetHeadX += Math.sin(elapsed * 14) * 0.22
        } else if (gestureActive && this.gesture.name === 'think') {
          targetHeadZ = 0.22
          targetHeadX -= 0.08
        } else if (gestureActive && this.gesture.name === 'shrug') {
          targetHeadZ = -0.15
        }

        const headLerp = Math.min(1, delta * 10)
        head.rotation.x += (targetHeadX - head.rotation.x) * headLerp
        head.rotation.y += (targetHeadY - head.rotation.y) * headLerp
        head.rotation.z += (targetHeadZ - head.rotation.z) * headLerp

        // Update 3D eye lookAt target in front of the head
        const headPos = this.scratchHeadPos.set(0, 0, 0)
        head.getWorldPosition(headPos)
        this.lookAtTarget.position.set(
          headPos.x + this.currentLookX * 0.7,
          headPos.y + this.currentLookY * 0.6,
          headPos.z + 1.5
        )
      }

      // 4. Arm idle sway + wave/shrug gestures
      const gestureActive = elapsed < this.gesture.until
      for (const arm of this.arms) {
        let targetZ = arm.baseZ + Math.sin(elapsed * 1.8) * 0.015
        if (gestureActive && this.gesture.name === 'wave' && arm.side === 'right') {
          targetZ = arm.baseZ * 0.15 + Math.sin(elapsed * 14) * 0.25
        } else if (gestureActive && this.gesture.name === 'shrug') {
          targetZ = arm.baseZ * 0.75
        }
        arm.node.rotation.z += (targetZ - arm.node.rotation.z) * Math.min(1, delta * 8)
      }

      // 5. Smooth emotion lerping + randomized blinking + lip-sync
      if (this.vrm.expressionManager) {
        const expLerp = Math.min(1, delta * 7)
        for (const preset of EMOTION_PRESETS) {
          const target = preset === this.activeEmotion ? 1.0 : 0.0
          this.emotionWeights[preset] += (target - this.emotionWeights[preset]) * expLerp
          this.vrm.expressionManager.setValue(preset, this.emotionWeights[preset])
        }

        // Random blink state machine
        if (elapsed >= this.nextBlinkAt && this.blinkStartAt < 0) {
          this.blinkStartAt = elapsed
          this.nextBlinkAt = elapsed + 2.0 + Math.random() * 3.5
        }
        let blinkWeight = 0
        if (this.blinkStartAt >= 0) {
          const progress = (elapsed - this.blinkStartAt) / this.blinkDuration
          if (progress >= 1) {
            this.blinkStartAt = -1
          } else {
            blinkWeight = Math.sin(progress * Math.PI)
          }
        }
        // Suppress full blink when happy eyes are active so morphs don't over-clip
        const effectiveBlink = blinkWeight * (1 - this.emotionWeights.happy * 0.85)
        this.vrm.expressionManager.setValue('blink', effectiveBlink)

        this.vrm.expressionManager.setValue('aa', this.currentMouth)
        this.vrm.expressionManager.setValue('oh', this.currentMouth * 0.35)
      }

      this.vrm.update(delta)
    }

    if (this.placeholder) {
      const pulse = 1 + this.currentMouth * 0.22
      this.placeholder.scale.set(pulse, pulse, pulse)
      this.placeholder.position.y = Math.sin(elapsed * 1.5) * 0.05
      this.placeholder.rotation.y = elapsed * (this.speaking ? 1.8 : 0.4) + this.currentLookX * 0.5
      this.placeholder.rotation.x = this.currentLookY * 0.35
    }
  }

  private relaxArms(vrm: VRM): void {
    this.arms = []
    const tmp = new THREE.Vector3()
    for (const side of ['left', 'right'] as const) {
      const upper = vrm.humanoid.getNormalizedBoneNode(`${side}UpperArm`)
      const hand = vrm.humanoid.getNormalizedBoneNode(`${side}Hand`)
      if (!upper || !hand) continue
      let bestZ = 0
      let lowestY = Infinity
      for (const z of [-1.3, 1.3]) {
        upper.rotation.z = z
        vrm.scene.updateMatrixWorld(true)
        hand.getWorldPosition(tmp)
        if (tmp.y < lowestY) {
          lowestY = tmp.y
          bestZ = z
        }
      }
      upper.rotation.z = bestZ
      this.arms.push({ side, node: upper, baseZ: bestZ })
    }
  }

  private frame(): void {
    const size = this.bounds.getSize(new THREE.Vector3())
    const center = this.bounds.getCenter(new THREE.Vector3())
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2
    const fitHeight = size.y / 2 / Math.tan(halfFov)
    const fitWidth = size.x / 2 / (Math.tan(halfFov) * this.camera.aspect)
    const distance = Math.max(fitHeight, fitWidth) * 1.08 + size.z / 2
    this.camera.position.set(center.x, center.y, center.z + distance)
    this.camera.lookAt(center)
    this.camera.near = Math.max(distance / 100, 0.01)
    this.camera.far = distance * 10
    this.camera.updateProjectionMatrix()
  }

  private clear(): void {
    if (this.vrm) {
      this.scene.remove(this.vrm.scene)
      VRMUtils.deepDispose(this.vrm.scene)
      this.vrm = null
    }
    if (this.placeholder) {
      this.scene.remove(this.placeholder)
      this.placeholder.geometry.dispose()
      ;(this.placeholder.material as THREE.Material).dispose()
      this.placeholder = null
    }
    this.arms = []
  }
}



