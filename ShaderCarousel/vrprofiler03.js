/**
 * VR Profiler v3 - Simplified Multi-Shader Performance Monitor
 * 
 * Profiles all shaders from tsl folder with 4 scale cycles per shader
 * Properly updates all carousel spheres with new shaders
 */

class VRProfiler {
    constructor(options = {}) {
        // Configuration
        this.config = {
            scales: options.scales || [1, 3, 6, 10],
            sampleAngles: options.sampleAngles || [90, 270],
            angleThreshold: options.angleThreshold || 30,
            sampleInterval: options.sampleInterval || 50,
            cycleDelay: options.cycleDelay || 3000,
            tslFolderPath: options.tslFolderPath || './tsl/'
        };

        // Shader list and cycling state
        this.shaderList = [];
        this.currentShaderIndex = 0;
        this.currentScaleIndex = 0;
        
        // Performance tracking
        this.lastTime = performance.now();
        this.frameTime = 0;
        this.fps = 0;
        this.meshCount = 0;
        this.performanceData = [];
        
        // References
        this.carousel = null;
        this.carouselEntity = null;
        
        // Timers
        this.logInterval = null;
        this.cycleTimer = null;
        
        // State
        this.lastLoggedAngle = null;
        this.meshCountReached = false;
        
        this.createUI();
        this.startProfiling();
        this.loadShaderList();
    }

    async loadShaderList() {
        // Try to load shader list
        try {
            const response = await fetch(`${this.config.tslFolderPath}shaders.json`).catch(() => null);
            
            if (response && response.ok) {
                const data = await response.json();
                this.shaderList = data.shaders || [];
            } else {
                // Use default list
                this.shaderList = this.getDefaultShaderList();
            }
            
            console.log(`✓ Loaded ${this.shaderList.length} shaders to profile`);
            this.showNotification(`Ready to profile ${this.shaderList.length} shaders`, 3000);
            
            // Start profiling
            this.waitForCarousel();
            
        } catch (error) {
            console.error('Failed to load shader list:', error);
            this.shaderList = this.getDefaultShaderList();
            this.waitForCarousel();
        }
    }

    getDefaultShaderList() {
        return [
            'brain.js', 'camouflage.js', 'caustics.js', 'cave-art.js',
            'circle-decor.js', 'circles.js', 'clouds.js', 'concrete.js',
            'cork.js', 'crumpled-fabric.js', 'dalmatian-spots.js', 'darth-maul.js',
            'dyson-sphere.js', 'entangled.js', 'fordite.js', 'gas-giant.js',
            'grid.js', 'isolayers.js', 'isolines.js', 'karst-rock.js',
            'marble.js', 'melter.js', 'neon-lights.js', 'photosphere.js',
            'planet.js', 'polka-dots.js', 'processed-wood.js', 'protozoa.js',
            'reticular-veins.js', 'roman-paving.js', 'rotator.js', 'rough-clay.js',
            'runny-eggs.js', 'rust.js', 'satin.js', 'scaler.js',
            'scepter-head.js', 'scream.js', 'simplex-noise.js', 'stars.js',
            'static-noise.js', 'supersphere.js', 'tiger-fur.js', 'translator.js',
            'turbulent-smoke.js', 'voronoi-cells.js', 'water-drops.js', 'watermelon.js',
            'wood.js', 'zebra-lines.js'
        ];
    }

    waitForCarousel(retries = 0) {
        if (!AFRAME.components['tsl-shader']) {
            setTimeout(() => this.waitForCarousel(retries), 100);
            return;
        }

        this.carouselEntity = document.querySelector('[carousel]');
        
        if (!this.carouselEntity || !this.carouselEntity.components?.carousel) {
            if (retries > 50) {
                console.error('Carousel not found');
                return;
            }
            setTimeout(() => this.waitForCarousel(retries + 1), 100);
            return;
        }

        this.carousel = this.carouselEntity.components.carousel;
        console.log(`✓ Carousel ready`);
        
        // Start with first shader and first scale
        this.applyCurrentShader();
        this.startLogging();
        this.startCycleMonitoring();
    }

    applyCurrentShader() {
        const template = this.carouselEntity.querySelector('[tsl-shader]');
        if (!template) return;

        const shaderFile = this.shaderList[this.currentShaderIndex];
        const scale = this.config.scales[this.currentScaleIndex];
        
        // Parse existing attributes
        const attrValue = template.getAttribute('tsl-shader') || '';
        const params = {};
        
        attrValue.split(';').forEach(pair => {
            const [key, value] = pair.split(':').map(s => s.trim());
            if (key && value) params[key] = value;
        });
        
        // Update shader and scale
        params.src = `${this.config.tslFolderPath}${shaderFile}`;
        params.scale = scale.toString();
        
        // Build new attribute string
        const newAttr = Object.entries(params)
            .map(([key, value]) => `${key}: ${value}`)
            .join('; ');
        
        // Update template
        template.setAttribute('tsl-shader', newAttr);
        
        // Update all existing carousel entities with the new shader
        this.updateAllCarouselEntities(newAttr);
        
        const shaderName = shaderFile.replace('.js', '').replace(/-/g, ' ');
        console.log(`→ Shader: ${shaderName} (${this.currentShaderIndex + 1}/${this.shaderList.length}), Scale: ${scale}`);
        this.showNotification(`${shaderName} - Scale ${scale}`, 2000);
    }

    updateAllCarouselEntities(shaderAttr) {
        // Find all entities created by the carousel (they have the carousel's template applied)
        const carouselEntities = this.carouselEntity.querySelectorAll('[tsl-shader]');
        
        carouselEntities.forEach((entity, index) => {
            // Skip the template itself (first child)
            if (entity === this.carouselEntity.querySelector('[tsl-shader]')) {
                return;
            }
            
            // Remove old shader component
            if (entity.components && entity.components['tsl-shader']) {
                entity.removeAttribute('tsl-shader');
            }
            
            // Add a small delay to ensure removal is processed
            setTimeout(() => {
                entity.setAttribute('tsl-shader', shaderAttr);
            }, 50);
        });
        
        console.log(`Updated ${carouselEntities.length - 1} carousel entities with new shader`);
    }

    startCycleMonitoring() {
        if (this.cycleTimer) {
            clearTimeout(this.cycleTimer);
        }

        // Simple timer-based approach - wait for cycle delay then move to next
        this.cycleTimer = setTimeout(() => {
            this.onCycleComplete();
        }, this.config.cycleDelay);
    }

    onCycleComplete() {
        this.currentScaleIndex++;
        
        // Check if we've done all scales for this shader
        if (this.currentScaleIndex >= this.config.scales.length) {
            this.currentScaleIndex = 0;
            this.currentShaderIndex++;
            
            // Check if we've done all shaders
            if (this.currentShaderIndex >= this.shaderList.length) {
                console.log('✓ All shaders profiled!');
                this.proposeDownload();
                return;
            }
        }
        
        // Apply next configuration
        this.applyCurrentShader();
        this.startCycleMonitoring();
    }

    createUI() {
        this.uiElement = document.createElement('div');
        this.uiElement.id = 'vr-profiler-window';
        Object.assign(this.uiElement.style, {
            position: 'fixed',
            top: '10px',
            right: '10px',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '10px',
            borderRadius: '5px',
            fontFamily: 'monospace',
            fontSize: '12px',
            zIndex: '1000',
            minWidth: '200px'
        });
        
        document.body.appendChild(this.uiElement);
    }

    startProfiling() {
        const animate = () => {
            const currentTime = performance.now();
            this.frameTime = currentTime - this.lastTime;
            this.lastTime = currentTime;
            this.fps = 1000 / this.frameTime;
            
            this.updateMeshCount();
            this.updateUI();
            requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }

    updateMeshCount() {
        let count = 0;
        const carousel = this.carouselEntity;
        
        if (carousel?.object3D) {
            carousel.object3D.traverse((obj) => {
                if (obj.isMesh && obj.visible) {
                    count++;
                }
            });
        }
        
        this.meshCount = count;
    }

    updateUI() {
        const shaderFile = this.shaderList[this.currentShaderIndex] || 'None';
        const shaderName = shaderFile.replace('.js', '').replace(/-/g, ' ');
        const scale = this.config.scales[this.currentScaleIndex];
        const progress = this.currentShaderIndex * this.config.scales.length + this.currentScaleIndex + 1;
        const total = this.shaderList.length * this.config.scales.length;
        
        let angle = 0;
        if (this.carousel?.angle !== undefined) {
            angle = this.carousel.angle % 360;
        }
        
        this.uiElement.innerHTML = `
            <strong>Shader ${this.currentShaderIndex + 1}/${this.shaderList.length}</strong><br>
            ${shaderName}<br>
            Scale: ${scale}<br>
            Progress: ${progress}/${total}<br>
            <br>
            FPS: ${this.fps.toFixed(1)}<br>
            Frame: ${this.frameTime.toFixed(2)}ms<br>
            Meshes: ${this.meshCount}<br>
            Angle: ${angle.toFixed(1)}°<br>
            Samples: ${this.performanceData.length}
        `;
    }

    startLogging() {
        if (this.logInterval) {
            clearInterval(this.logInterval);
        }

        this.logInterval = setInterval(() => {
            if (!this.carousel) return;
            
            const currentAngle = this.carousel.angle % 360;
            
            // Check if at sample angle
            const isAtTargetAngle = this.config.sampleAngles.some(targetAngle => 
                Math.abs(currentAngle - targetAngle) < this.config.angleThreshold
            );
            
            if (isAtTargetAngle) {
                const targetAngle = this.config.sampleAngles.find(angle => 
                    Math.abs(currentAngle - angle) < this.config.angleThreshold
                );
                
                // Prevent duplicate samples
                if (this.lastLoggedAngle === targetAngle) return;
                
                const shaderFile = this.shaderList[this.currentShaderIndex];
                const scale = this.config.scales[this.currentScaleIndex];
                
                const logEntry = {
                    timestamp: performance.now(),
                    frameTime: this.frameTime,
                    fps: this.fps,
                    meshCount: this.meshCount,
                    angle: targetAngle,
                    scale: scale,
                    shaderIndex: this.currentShaderIndex,
                    shaderFile: shaderFile,
                    scaleIndex: this.currentScaleIndex
                };
                
                this.performanceData.push(logEntry);
                this.lastLoggedAngle = targetAngle;
                
                console.log(`Sample at ${targetAngle}° - FPS: ${this.fps.toFixed(1)}, Shader: ${shaderFile}, Scale: ${scale}`);
            } else {
                // Reset when away from target angles
                if (Math.abs(currentAngle - 0) < this.config.angleThreshold || 
                    Math.abs(currentAngle - 180) < this.config.angleThreshold) {
                    this.lastLoggedAngle = null;
                }
            }
        }, this.config.sampleInterval);
    }

    proposeDownload() {
        clearInterval(this.logInterval);
        clearTimeout(this.cycleTimer);
        
        this.uiElement.style.cursor = 'pointer';
        this.uiElement.style.backgroundColor = 'rgba(76, 175, 80, 0.8)';
        this.uiElement.innerHTML += '<br><small>📊 Click to download</small>';
        
        this.uiElement.addEventListener('click', () => this.downloadStats(), { once: true });
    }

    downloadStats() {
        const stats = {
            metadata: {
                version: '3.0-simplified',
                generatedAt: new Date().toISOString(),
                configuration: this.config
            },
            summary: {
                totalShaders: this.shaderList.length,
                totalSamples: this.performanceData.length,
                scales: this.config.scales
            },
            shaderList: this.shaderList,
            samples: this.performanceData
        };

        const dataStr = JSON.stringify(stats, null, 2);
        const blob = new Blob([dataStr], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = url;
        link.download = `shader-performance-${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        this.showNotification('Stats downloaded!');
    }

    showNotification(message, duration = 3000) {
        const notification = document.createElement('div');
        notification.textContent = message;
        Object.assign(notification.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            backgroundColor: 'rgba(0, 0, 0, 0.9)',
            color: 'white',
            padding: '20px',
            borderRadius: '10px',
            fontSize: '16px',
            zIndex: '10000',
            textAlign: 'center'
        });
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, duration);
    }

    destroy() {
        clearInterval(this.logInterval);
        clearTimeout(this.cycleTimer);
        
        if (this.uiElement?.parentNode) {
            this.uiElement.parentNode.removeChild(this.uiElement);
        }
        
        console.log('VRProfiler destroyed');
    }
}

// Initialize
let vrProfilerInstance = null;

document.addEventListener('DOMContentLoaded', async () => {
    // Wait for A-Frame
    const waitForScene = () => {
        return new Promise((resolve) => {
            const check = () => {
                const scene = document.querySelector('a-scene');
                if (scene?.hasLoaded) {
                    resolve();
                } else if (scene) {
                    scene.addEventListener('loaded', resolve, { once: true });
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    };
    
    await waitForScene();
    
    // Prevent duplicates
    if (vrProfilerInstance) {
        vrProfilerInstance.destroy();
    }
    
    vrProfilerInstance = new VRProfiler();
});