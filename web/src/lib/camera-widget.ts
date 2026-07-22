/**
 * Three.js 3D camera-rig widget.
 * Ported from https://github.com/jtydhr88/ComfyUI-qwenmultiangle (MIT)
 * Adapted for React / plain DOM — no Vue / ComfyUI dependencies.
 */
import * as THREE from "three";

export interface CameraState {
    azimuth: number;   // 0-360  (horizontal, 0 = front)
    elevation: number; // -30 to 60 (vertical, 0 = eye-level)
    distance: number;  // 0-10
    imageUrl: string | null;
}

export interface CameraWidgetOptions {
    container: HTMLElement;
    initialState?: Partial<CameraState>;
    onStateChange?: (state: CameraState) => void;
}

export class CameraWidget {
    private container: HTMLElement;
    private state: CameraState;
    private onStateChange?: (state: CameraState) => void;

    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private previewCamera!: THREE.PerspectiveCamera;
    private renderer!: THREE.WebGLRenderer;
    private activeCamera!: THREE.Camera;

    private cameraIndicator!: THREE.Mesh;
    private camGlow!: THREE.Mesh;
    private azimuthHandle!: THREE.Mesh;
    private azGlow!: THREE.Mesh;
    private elevationHandle!: THREE.Mesh;
    private elGlow!: THREE.Mesh;
    private distanceHandle!: THREE.Mesh;
    private distGlow!: THREE.Mesh;
    private glowRing!: THREE.Mesh;
    private imagePlane!: THREE.Mesh;
    private imageFrame!: THREE.LineSegments;
    private planeMat!: THREE.MeshBasicMaterial;
    private distanceTube: THREE.Mesh | null = null;

    private azimuthRing!: THREE.Mesh;
    private elevationArc!: THREE.Mesh;
    private gridHelper!: THREE.GridHelper;

    private readonly CENTER = new THREE.Vector3(0, 0.5, 0);
    private readonly AZIMUTH_RADIUS = 1.8;
    private readonly ELEVATION_RADIUS = 1.4;
    private readonly ELEV_ARC_X = -0.8;

    private liveAzimuth = 0;
    private liveElevation = 0;
    private liveDistance = 5;

    private isDragging = false;
    private dragTarget: string | null = null;
    private hoveredHandle: { mesh: THREE.Mesh; glow: THREE.Mesh; name: string } | null = null;
    private raycaster = new THREE.Raycaster();
    private mouse = new THREE.Vector2();

    private useCameraView = false;
    private isOrbitDragging = false;
    private orbitStartX = 0;
    private orbitStartY = 0;
    private orbitStartAzimuth = 0;
    private orbitStartElevation = 0;

    private animationId: number | null = null;
    private time = 0;

    private resizeObserver: ResizeObserver | null = null;

    constructor(options: CameraWidgetOptions) {
        this.container = options.container;
        this.onStateChange = options.onStateChange;
        this.state = {
            azimuth: options.initialState?.azimuth ?? 0,
            elevation: options.initialState?.elevation ?? 0,
            distance: options.initialState?.distance ?? 5,
            imageUrl: options.initialState?.imageUrl ?? null,
        };
        this.liveAzimuth = this.state.azimuth;
        this.liveElevation = this.state.elevation;
        this.liveDistance = this.state.distance;
        this.initThreeJS();
        this.bindEvents();
        this.animate();
    }

    private initThreeJS(): void {
        const width = this.container.clientWidth || 300;
        const height = this.container.clientHeight || 300;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0f);

        this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
        this.camera.position.set(4, 3.5, 4);
        this.camera.lookAt(0, 0.3, 0);

        this.previewCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
        this.activeCamera = this.camera;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(width, height, false);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.container.appendChild(this.renderer.domElement);

        const canvas = this.renderer.domElement;
        canvas.style.position = "absolute";
        canvas.style.top = "0";
        canvas.style.left = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
        const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
        mainLight.position.set(5, 10, 5);
        this.scene.add(mainLight);
        const fillLight = new THREE.DirectionalLight(0xe93d82, 0.3);
        fillLight.position.set(-5, 5, -5);
        this.scene.add(fillLight);

        this.gridHelper = new THREE.GridHelper(5, 20, 0x1a1a2e, 0x12121a);
        this.gridHelper.position.y = -0.01;
        this.scene.add(this.gridHelper);

        this.createSubject();
        this.createCameraIndicator();
        this.createAzimuthRing();
        this.createElevationArc();
        this.createDistanceHandle();
        this.updateVisuals();
    }

    private createGridTexture(): THREE.CanvasTexture {
        const cvs = document.createElement("canvas");
        cvs.width = 256; cvs.height = 256;
        const ctx = cvs.getContext("2d")!;
        ctx.fillStyle = "#1a1a2a"; ctx.fillRect(0, 0, 256, 256);
        ctx.strokeStyle = "#2a2a3a"; ctx.lineWidth = 1;
        for (let i = 0; i <= 256; i += 16) {
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
        }
        const tex = new THREE.CanvasTexture(cvs);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(4, 4);
        return tex;
    }

    private createSubject(): void {
        const cardGeo = new THREE.BoxGeometry(1.2, 1.2, 0.02);
        const frontMat = new THREE.MeshBasicMaterial({ color: 0x3a3a4a });
        const backMat = new THREE.MeshBasicMaterial({ map: this.createGridTexture() });
        const edgeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a2a });
        this.imagePlane = new THREE.Mesh(cardGeo, [edgeMat, edgeMat, edgeMat, edgeMat, frontMat, backMat]);
        this.imagePlane.position.copy(this.CENTER);
        this.scene.add(this.imagePlane);
        this.planeMat = frontMat;

        const frameMat = new THREE.LineBasicMaterial({ color: 0xe93d82 });
        this.imageFrame = new THREE.LineSegments(new THREE.EdgesGeometry(cardGeo), frameMat);
        this.imageFrame.position.copy(this.CENTER);
        this.scene.add(this.imageFrame);

        this.glowRing = new THREE.Mesh(
            new THREE.RingGeometry(0.55, 0.58, 64),
            new THREE.MeshBasicMaterial({ color: 0xe93d82, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
        );
        this.glowRing.position.set(0, 0.01, 0);
        this.glowRing.rotation.x = -Math.PI / 2;
        this.scene.add(this.glowRing);
    }

    private createCameraIndicator(): void {
        this.cameraIndicator = new THREE.Mesh(
            new THREE.ConeGeometry(0.15, 0.4, 4),
            new THREE.MeshStandardMaterial({ color: 0xe93d82, emissive: 0xe93d82, emissiveIntensity: 0.5, metalness: 0.8, roughness: 0.2 }),
        );
        this.scene.add(this.cameraIndicator);
        this.camGlow = new THREE.Mesh(
            new THREE.SphereGeometry(0.08, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xff6ba8, transparent: true, opacity: 0.8 }),
        );
        this.scene.add(this.camGlow);
    }

    private createAzimuthRing(): void {
        this.azimuthRing = new THREE.Mesh(
            new THREE.TorusGeometry(this.AZIMUTH_RADIUS, 0.04, 16, 100),
            new THREE.MeshBasicMaterial({ color: 0xe93d82, transparent: true, opacity: 0.7 }),
        );
        this.azimuthRing.rotation.x = Math.PI / 2;
        this.azimuthRing.position.y = 0.02;
        this.scene.add(this.azimuthRing);

        this.azimuthHandle = new THREE.Mesh(
            new THREE.SphereGeometry(0.16, 32, 32),
            new THREE.MeshStandardMaterial({ color: 0xe93d82, emissive: 0xe93d82, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 }),
        );
        this.scene.add(this.azimuthHandle);

        this.azGlow = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xe93d82, transparent: true, opacity: 0.2 }),
        );
        this.scene.add(this.azGlow);
    }

    private createElevationArc(): void {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 32; i++) {
            const a = (-30 + (90 * i) / 32) * (Math.PI / 180);
            pts.push(new THREE.Vector3(this.ELEV_ARC_X, this.ELEVATION_RADIUS * Math.sin(a) + this.CENTER.y, this.ELEVATION_RADIUS * Math.cos(a)));
        }
        this.elevationArc = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, 0.04, 8, false),
            new THREE.MeshBasicMaterial({ color: 0x00ffd0, transparent: true, opacity: 0.8 }),
        );
        this.scene.add(this.elevationArc);

        this.elevationHandle = new THREE.Mesh(
            new THREE.SphereGeometry(0.16, 32, 32),
            new THREE.MeshStandardMaterial({ color: 0x00ffd0, emissive: 0x00ffd0, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 }),
        );
        this.scene.add(this.elevationHandle);

        this.elGlow = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0x00ffd0, transparent: true, opacity: 0.2 }),
        );
        this.scene.add(this.elGlow);
    }

    private createDistanceHandle(): void {
        this.distanceHandle = new THREE.Mesh(
            new THREE.SphereGeometry(0.15, 32, 32),
            new THREE.MeshStandardMaterial({ color: 0xffb800, emissive: 0xffb800, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.3 }),
        );
        this.scene.add(this.distanceHandle);

        this.distGlow = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xffb800, transparent: true, opacity: 0.25 }),
        );
        this.scene.add(this.distGlow);
    }

    private updateDistanceLine(start: THREE.Vector3, end: THREE.Vector3): void {
        if (this.distanceTube) {
            this.scene.remove(this.distanceTube);
            this.distanceTube.geometry.dispose();
            (this.distanceTube.material as THREE.Material).dispose();
        }
        this.distanceTube = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.LineCurve3(start, end), 1, 0.025, 8, false),
            new THREE.MeshBasicMaterial({ color: 0xffb800, transparent: true, opacity: 0.8 }),
        );
        this.scene.add(this.distanceTube);
    }

    private updateVisuals(): void {
        const azRad = (this.liveAzimuth * Math.PI) / 180;
        const elRad = (this.liveElevation * Math.PI) / 180;
        const visualDist = 2.6 - (this.liveDistance / 10) * 2.0;

        const camX = visualDist * Math.sin(azRad) * Math.cos(elRad);
        const camY = this.CENTER.y + visualDist * Math.sin(elRad);
        const camZ = visualDist * Math.cos(azRad) * Math.cos(elRad);

        this.cameraIndicator.position.set(camX, camY, camZ);
        this.cameraIndicator.lookAt(this.CENTER);
        this.cameraIndicator.rotateX(Math.PI / 2);
        this.camGlow.position.copy(this.cameraIndicator.position);

        const azX = this.AZIMUTH_RADIUS * Math.sin(azRad);
        const azZ = this.AZIMUTH_RADIUS * Math.cos(azRad);
        this.azimuthHandle.position.set(azX, 0.16, azZ);
        this.azGlow.position.copy(this.azimuthHandle.position);

        const elY = this.CENTER.y + this.ELEVATION_RADIUS * Math.sin(elRad);
        const elZ = this.ELEVATION_RADIUS * Math.cos(elRad);
        this.elevationHandle.position.set(this.ELEV_ARC_X, elY, elZ);
        this.elGlow.position.copy(this.elevationHandle.position);

        const distT = 0.15 + ((10 - this.liveDistance) / 10) * 0.7;
        this.distanceHandle.position.lerpVectors(this.CENTER, this.cameraIndicator.position, distT);
        this.distGlow.position.copy(this.distanceHandle.position);

        this.updateDistanceLine(this.CENTER.clone(), this.cameraIndicator.position.clone());
        this.previewCamera.position.copy(this.cameraIndicator.position);
        this.previewCamera.lookAt(this.CENTER);
        this.glowRing.rotation.z += 0.005;
    }

    private bindEvents(): void {
        const canvas = this.renderer.domElement;
        canvas.addEventListener("mousedown", this.onPointerDown);
        canvas.addEventListener("mousemove", this.onPointerMove);
        canvas.addEventListener("mouseup", this.onPointerUp);
        canvas.addEventListener("mouseleave", this.onPointerUp);
        canvas.addEventListener("touchstart", (e) => { e.preventDefault(); this.onPointerDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY } as MouseEvent); }, { passive: false });
        canvas.addEventListener("touchmove", (e) => { e.preventDefault(); this.onPointerMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY } as MouseEvent); }, { passive: false });
        canvas.addEventListener("touchend", () => this.onPointerUp());
        canvas.addEventListener("wheel", this.onWheel, { passive: false });
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.container);
    }

    private getMousePos(event: MouseEvent): void {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    private setHandleScale(handle: THREE.Mesh, glow: THREE.Mesh | null, scale: number): void {
        handle.scale.setScalar(scale);
        if (glow) glow.scale.setScalar(scale);
    }

    private onPointerDown = (event: MouseEvent): void => {
        this.getMousePos(event);
        if (this.useCameraView) {
            this.isOrbitDragging = true;
            this.orbitStartX = event.clientX; this.orbitStartY = event.clientY;
            this.orbitStartAzimuth = this.liveAzimuth; this.orbitStartElevation = this.liveElevation;
            this.renderer.domElement.style.cursor = "grabbing";
            return;
        }
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const handles = [
            { mesh: this.azimuthHandle, glow: this.azGlow, name: "azimuth" },
            { mesh: this.elevationHandle, glow: this.elGlow, name: "elevation" },
            { mesh: this.distanceHandle, glow: this.distGlow, name: "distance" },
        ];
        for (const h of handles) {
            if (this.raycaster.intersectObject(h.mesh).length > 0) {
                this.isDragging = true; this.dragTarget = h.name;
                this.setHandleScale(h.mesh, h.glow, 1.3);
                this.renderer.domElement.style.cursor = "grabbing";
                return;
            }
        }
    };

    private onPointerMove = (event: MouseEvent): void => {
        this.getMousePos(event);
        if (this.useCameraView && this.isOrbitDragging) {
            const dx = event.clientX - this.orbitStartX;
            const dy = event.clientY - this.orbitStartY;
            let newAz = this.orbitStartAzimuth - dx * 0.5;
            while (newAz < 0) newAz += 360;
            while (newAz >= 360) newAz -= 360;
            this.liveAzimuth = newAz; this.state.azimuth = Math.round(newAz);
            this.liveElevation = Math.max(-30, Math.min(60, this.orbitStartElevation + dy * 0.5));
            this.state.elevation = Math.round(this.liveElevation);
            this.updateVisuals(); this.notifyStateChange();
            return;
        }
        this.raycaster.setFromCamera(this.mouse, this.camera);
        if (!this.isDragging) {
            const handles = [
                { mesh: this.azimuthHandle, glow: this.azGlow, name: "azimuth" },
                { mesh: this.elevationHandle, glow: this.elGlow, name: "elevation" },
                { mesh: this.distanceHandle, glow: this.distGlow, name: "distance" },
            ];
            let found: typeof handles[0] | null = null;
            for (const h of handles) {
                if (this.raycaster.intersectObject(h.mesh).length > 0) { found = h; break; }
            }
            if (this.hoveredHandle && this.hoveredHandle !== found) this.setHandleScale(this.hoveredHandle.mesh, this.hoveredHandle.glow, 1.0);
            if (found) {
                this.setHandleScale(found.mesh, found.glow, 1.15);
                this.renderer.domElement.style.cursor = "grab";
                this.hoveredHandle = found;
            } else {
                this.renderer.domElement.style.cursor = "default";
                this.hoveredHandle = null;
            }
            return;
        }
        const intersect = new THREE.Vector3();
        if (this.dragTarget === "azimuth") {
            const plane = new THREE.Plane(); plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
            if (this.raycaster.ray.intersectPlane(plane, intersect)) {
                let angle = Math.atan2(intersect.x, intersect.z) * (180 / Math.PI);
                if (angle < 0) angle += 360;
                this.liveAzimuth = Math.max(0, Math.min(360, angle));
                this.state.azimuth = Math.round(this.liveAzimuth);
                this.updateVisuals(); this.notifyStateChange();
            }
        } else if (this.dragTarget === "elevation") {
            const elevPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -this.ELEV_ARC_X);
            if (this.raycaster.ray.intersectPlane(elevPlane, intersect)) {
                let angle = Math.atan2(intersect.y - this.CENTER.y, intersect.z) * (180 / Math.PI);
                angle = Math.max(-30, Math.min(60, angle));
                this.liveElevation = angle; this.state.elevation = Math.round(angle);
                this.updateVisuals(); this.notifyStateChange();
            }
        } else if (this.dragTarget === "distance") {
            const newDist = Math.max(0, Math.min(10, 5 - this.mouse.y * 5));
            this.liveDistance = newDist; this.state.distance = Math.round(newDist * 10) / 10;
            this.updateVisuals(); this.notifyStateChange();
        }
    };

    private onPointerUp = (): void => {
        if (this.isOrbitDragging) {
            this.isOrbitDragging = false;
            this.renderer.domElement.style.cursor = this.useCameraView ? "grab" : "default";
            return;
        }
        if (this.isDragging) {
            [{ mesh: this.azimuthHandle, glow: this.azGlow }, { mesh: this.elevationHandle, glow: this.elGlow }, { mesh: this.distanceHandle, glow: this.distGlow }]
                .forEach(h => this.setHandleScale(h.mesh, h.glow, 1.0));
        }
        this.isDragging = false; this.dragTarget = null;
        this.renderer.domElement.style.cursor = "default";
    };

    private onWheel = (event: WheelEvent): void => {
        if (!this.useCameraView) return;
        event.preventDefault();
        this.liveDistance = Math.max(0, Math.min(10, this.liveDistance - event.deltaY * 0.01));
        this.state.distance = Math.round(this.liveDistance * 10) / 10;
        this.updateVisuals(); this.notifyStateChange();
    };

    private onResize(): void {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        if (w === 0 || h === 0) return;
        this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
        this.previewCamera.aspect = w / h; this.previewCamera.updateProjectionMatrix();
        this.renderer.setSize(w, h, false);
    }

    private animate = (): void => {
        this.animationId = requestAnimationFrame(this.animate);
        this.time += 0.01;
        this.camGlow.scale.setScalar(1 + Math.sin(this.time * 2) * 0.03);
        this.glowRing.rotation.z += 0.003;
        this.renderer.render(this.scene, this.activeCamera);
    };

    private notifyStateChange(): void {
        this.onStateChange?.({ ...this.state });
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /** Generate camera-angle prompt from current state (English terms). */
    public generatePrompt(): string {
        const h = this.state.azimuth % 360;
        let hDir: string;
        if (h < 22.5 || h >= 337.5) hDir = "front view";
        else if (h < 67.5) hDir = "front-right quarter view";
        else if (h < 112.5) hDir = "right side view";
        else if (h < 157.5) hDir = "back-right quarter view";
        else if (h < 202.5) hDir = "back view";
        else if (h < 247.5) hDir = "back-left quarter view";
        else if (h < 292.5) hDir = "left side view";
        else hDir = "front-left quarter view";

        let vDir: string;
        if (this.state.elevation < -15) vDir = "low-angle shot";
        else if (this.state.elevation < 15) vDir = "eye-level shot";
        else if (this.state.elevation < 45) vDir = "elevated shot";
        else vDir = "high-angle shot";

        const dist = this.state.distance < 2 ? "wide shot" : this.state.distance < 6 ? "medium shot" : "close-up";
        return `${hDir}, ${vDir}, ${dist}`;
    }

    public setState(next: Partial<CameraState>): void {
        if (next.azimuth !== undefined) { this.state.azimuth = next.azimuth; this.liveAzimuth = next.azimuth; }
        if (next.elevation !== undefined) { this.state.elevation = next.elevation; this.liveElevation = next.elevation; }
        if (next.distance !== undefined) { this.state.distance = next.distance; this.liveDistance = next.distance; }
        if (next.imageUrl !== undefined) { this.state.imageUrl = next.imageUrl; this.updateImage(next.imageUrl); }
        this.updateVisuals();
    }

    public getState(): CameraState { return { ...this.state }; }

    public setCameraView(enabled: boolean): void {
        this.useCameraView = enabled;
        this.isOrbitDragging = false;
        const show = !enabled;
        [this.azimuthRing, this.azimuthHandle, this.azGlow,
         this.elevationArc, this.elevationHandle, this.elGlow,
         this.distanceHandle, this.distGlow, this.cameraIndicator,
         this.camGlow, this.glowRing, this.gridHelper, this.imageFrame]
            .forEach(o => { o.visible = show; });
        if (this.distanceTube) this.distanceTube.visible = show;
        this.activeCamera = enabled ? this.previewCamera : this.camera;
        this.renderer.domElement.style.cursor = enabled ? "grab" : "default";
    }

    public updateImage(url: string | null): void {
        if (url) {
            const img = new Image();
            if (!url.startsWith("data:")) img.crossOrigin = "anonymous";
            img.onload = () => {
                const tex = new THREE.Texture(img);
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.needsUpdate = true;
                this.planeMat.map = tex; this.planeMat.color.set(0xffffff); this.planeMat.needsUpdate = true;
                const ar = img.width / img.height, max = 1.5;
                const sx = ar > 1 ? max : max * ar, sy = ar > 1 ? max / ar : max;
                this.imagePlane.scale.set(sx, sy, 1); this.imageFrame.scale.set(sx, sy, 1);
            };
            img.onerror = () => { this.planeMat.map = null; this.planeMat.color.set(0xe93d82); this.planeMat.needsUpdate = true; };
            img.src = url;
        } else {
            this.planeMat.map = null; this.planeMat.color.set(0x3a3a4a); this.planeMat.needsUpdate = true;
            this.imagePlane.scale.set(1, 1, 1); this.imageFrame.scale.set(1, 1, 1);
        }
    }

    public resetToDefaults(): void {
        this.setState({ azimuth: 0, elevation: 0, distance: 5 });
        this.notifyStateChange();
    }

    public dispose(): void {
        if (this.animationId !== null) { cancelAnimationFrame(this.animationId); this.animationId = null; }
        this.resizeObserver?.disconnect();
        this.renderer.dispose();
        this.scene.clear();
        if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
}
