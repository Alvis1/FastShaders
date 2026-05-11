class VRProfiler {
    constructor(options = {}) {
        // Configurable options
        this.config = {
            scales: options.scales || [1, 3, 6, 10],
            targetCycles: options.targetCycles || 4,
            sampleAngles: options.sampleAngles || [90, 270],
            angleThreshold: options.angleThreshold || 30,
            sampleInterval: options.sampleInterval || 50,
            maxSamples: options.maxSamples || 10000,
            cycleDelay: options.cycleDelay || 3000,
            carouselRetryLimit: options.carouselRetryLimit || 50
        };

        // Performance tracking
        this.lastTime = performance.now();
        this.frameTime = 0;
        this.fps = 0;
        this.meshCount = 0;
        this.performanceData = [];
        
        // Timers and intervals
        this.logInterval = null;
        this.cycleCheckInterval = null;
        this.cycleCompleteTimer = null;
        this.meshCountTimer = null;
        
        // State
        this.currentScaleIndex = 0;
        this.currentScale = this.config.scales[0];
        this.completedCycles = 0;
        this.maxMeshCount = null;
        this.meshCountReached = false;
        this.lastLoggedAngle = null;
        this.lastShaderName = null;
        this.lastShaderParams = null;
        
        // Cached references (updated when carousel recreated)
        this.carouselEntity = null;
        this.carousel = null;

        // Captured at startup, used when recreating carousel
        this.originalTemplateInfo = null;

        this.createUI();
        this.captureOriginalTemplate();
        this.startProfiling();
        this.waitForCarousel();
    }

    /**
     * Wait for carousel to be ready with retry limit
     */
    waitForCarousel(retries = 0) {
        this.carouselEntity = document.querySelector('[carousel]');

        if (!this.carouselEntity) {
            if (retries >= this.config.carouselRetryLimit) {
                console.error('Carousel not found after maximum retries');
                this.showNotification('Error: Carousel not found', 5000);
                return;
            }
            setTimeout(() => this.waitForCarousel(retries + 1), 100);
            return;
        }

        if (!this.carouselEntity.components || !this.carouselEntity.components.carousel) {
            if (retries >= this.config.carouselRetryLimit) {
                console.error('Carousel component not initialized after maximum retries');
                this.showNotification('Error: Carousel not initialized', 5000);
                return;
            }
            setTimeout(() => this.waitForCarousel(retries + 1), 100);
            return;
        }

        this.carousel = this.carouselEntity.components.carousel;
        this.maxMeshCount = this.carousel.data.maxCount || 5;
        console.log(`✓ Carousel ready - maxCount: ${this.maxMeshCount}`);
        
        // Start monitoring now that carousel is ready
        this.startLogging();
        this.startCycleMonitoring();
    }

    /**
     * Capture the original template once at startup, before any cloning happens.
     * Used by recreateCarousel to rebuild a fresh template after disposal.
     */
    captureOriginalTemplate() {
        setTimeout(() => {
            const carousel = document.querySelector('[carousel]');
            if (!carousel) {
                console.warn('Carousel not found, retrying...');
                setTimeout(() => this.captureOriginalTemplate(), 100);
                return;
            }

            const template = carousel.querySelector('[tsl-shader]');
            if (template) {
                this.originalTemplateInfo = {
                    tagName: template.tagName.toLowerCase(),
                    radius: template.getAttribute('radius'),
                    shaderAttr: template.getAttribute('tsl-shader')
                };
                console.log('✓ Captured original template info:', this.originalTemplateInfo);
            } else {
                console.error('Could not find template with tsl-shader attribute');
            }
        }, 500);
    }

    /**
     * Update cached carousel references after recreation
     */
    updateCarouselReferences() {
        this.carouselEntity = document.querySelector('[carousel]');
        if (this.carouselEntity && this.carouselEntity.components) {
            this.carousel = this.carouselEntity.components.carousel;
        }
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
            cursor: 'default',
            minWidth: '200px',
            maxWidth: '300px',
            lineHeight: '1.3'
        });
        
        // Create separate DOM elements for different parts (for efficient updates)
        this.uiShaderInfo = document.createElement('div');
        this.uiCycleInfo = document.createElement('div');
        this.uiPerformance = document.createElement('div');
        
        this.uiElement.appendChild(this.uiShaderInfo);
        this.uiElement.appendChild(this.uiCycleInfo);
        this.uiElement.appendChild(this.uiPerformance);
        
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
        // Cache mesh count and update less frequently (every 1 second)
        if (!this.meshCountTimer || performance.now() - this.meshCountTimer > 1000) {
            this.meshCountTimer = performance.now();
            
            if (!this.carouselEntity || !this.carouselEntity.object3D) {
                this.meshCount = 0;
                return;
            }
            
            // Count only visible meshes in the carousel's object3D
            this.meshCount = 0;
            this.carouselEntity.object3D.traverse((child) => {
                if ((child.isMesh || child.type === 'Mesh') && child.visible) {
                    let parentEntity = child.el || child.parent?.el;
                    if (!parentEntity || parentEntity.getAttribute('visible') !== false) {
                        this.meshCount++;
                    }
                }
            });
        }
    }

    getCurrentShaderInfo() {
        if (!this.carouselEntity) {
            return { name: null, params: null };
        }

        const shaderEntities = this.carouselEntity.querySelectorAll('[tsl-shader]:not([visible="false"])');
        
        if (shaderEntities.length === 0) {
            return { name: null, params: null };
        }

        const firstShaderEntity = shaderEntities[0];
        const attrValue = firstShaderEntity.getAttribute('tsl-shader');
        const parsedParams = {};
        
        if (typeof attrValue === 'string') {
            const pairs = attrValue.split(';').map(s => s.trim()).filter(s => s);
            pairs.forEach(pair => {
                const [key, ...valueParts] = pair.split(':');
                const value = valueParts.join(':').trim();
                if (key && value) {
                    parsedParams[key.trim()] = value;
                }
            });
        }
        
        let shaderName = 'Unknown';
        
        // Extract shader name from src path
        if (parsedParams.src) {
            const pathParts = parsedParams.src.split('/');
            const fileName = pathParts[pathParts.length - 1];
            shaderName = fileName.replace('.js', '').replace(/-/g, ' ');
            // Capitalize first letter of each word
            shaderName = shaderName.split(' ').map(word => 
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' ');
        }

        // Extract meaningful parameters (excluding default/empty values)
        const params = {};
        const importantParams = ['count', 'size', 'blur', 'scale', 'roughness', 'metalness', 'speed', 'smooth', 'wave', 'rings', 'fibers'];
        
        for (const param of importantParams) {
            if (parsedParams[param] !== undefined && parsedParams[param] !== '0') {
                params[param] = parsedParams[param];
            }
        }

        // Add color parameters if they're not default
        if (parsedParams.color && parsedParams.color !== '#000000') {
            params.color = parsedParams.color;
        }
        if (parsedParams.background && parsedParams.background !== '#ffffff') {
            params.bg = parsedParams.background;
        }

        return { name: shaderName, params: params };
    }

    destroy() {
        // Clear all intervals
        if (this.logInterval) {
            clearInterval(this.logInterval);
            this.logInterval = null;
        }
        if (this.cycleCheckInterval) {
            clearInterval(this.cycleCheckInterval);
            this.cycleCheckInterval = null;
        }
        
        // Clear timeout
        if (this.cycleCompleteTimer) {
            clearTimeout(this.cycleCompleteTimer);
            this.cycleCompleteTimer = null;
        }
        
        // Remove UI element
        if (this.uiElement && this.uiElement.parentNode) {
            this.uiElement.parentNode.removeChild(this.uiElement);
        }
        
        // Clear data and references
        this.performanceData = [];
        this.carouselEntity = null;
        this.carousel = null;
        
        console.log('VRProfiler destroyed');
    }

    updateUI() {
        const currentTimeSeconds = (performance.now() / 1000).toFixed(1);
        const shaderInfo = this.getCurrentShaderInfo();
        
        let rotationAngle = null;
        if (this.carousel && this.carousel.angle !== undefined) {
            rotationAngle = this.carousel.angle % 360;
        }
        
        // Update shader info section (less frequently changed)
        let shaderText = '';
        if (shaderInfo.name) {
            shaderText = `Shader: ${shaderInfo.name}<br>`;
            if (shaderInfo.params && Object.keys(shaderInfo.params).length > 0) {
                const paramEntries = Object.entries(shaderInfo.params);
                const displayParams = paramEntries.slice(0, 3);
                const paramStr = displayParams
                    .map(([key, value]) => {
                        if (typeof value === 'number') {
                            return `${key}: ${value.toString()}`;
                        }
                        return `${key}: ${value}`;
                    })
                    .join(', ');
                shaderText += `<small>${paramStr}${paramEntries.length > 3 ? '...' : ''}</small><br>`;
            }
            shaderText += '<br>';
        }
        if (this.uiShaderInfo.innerHTML !== shaderText) {
            this.uiShaderInfo.innerHTML = shaderText;
        }
        
        // Update cycle info section
        const cycleText = `<strong>Scale: ${this.currentScale} | Cycle: ${this.completedCycles}/${this.config.targetCycles}</strong><br><br>`;
        if (this.uiCycleInfo.innerHTML !== cycleText) {
            this.uiCycleInfo.innerHTML = cycleText;
        }
        
        // Update performance section (frequently changed)
        let perfText = `Time: ${currentTimeSeconds}s<br>Frame Time: ${this.frameTime.toFixed(2)} ms<br>FPS: ${this.fps.toFixed(1)}<br>Meshes: ${this.meshCount}`;
        
        if (rotationAngle !== null) {
            const isAt90 = Math.abs(rotationAngle - 90) < this.config.angleThreshold;
            const isAt270 = Math.abs(rotationAngle - 270) < this.config.angleThreshold;
            const sampling = (isAt90 || isAt270) ? ' 🔴' : '';
            perfText += `<br>Angle: ${rotationAngle.toFixed(1)}°${sampling}`;
            perfText += `<br>Samples: ${this.performanceData.length}`;
        }
        
        this.uiPerformance.innerHTML = perfText;
    }

    startLogging() {
        // Track last logged angle to prevent duplicate samples
        this.lastLoggedAngle = null;
        
        if (this.logInterval) {
            clearInterval(this.logInterval);
        }

        this.logInterval = setInterval(() => {
            if (!this.carousel || this.carousel.angle === undefined) {
                return;
            }
            
            const currentAngle = this.carousel.angle % 360;
            
            // Check if we're at any target angle
            const isAtTargetAngle = this.config.sampleAngles.some(targetAngle => 
                Math.abs(currentAngle - targetAngle) < this.config.angleThreshold
            );
            
            if (isAtTargetAngle) {
                const targetAngle = this.config.sampleAngles.find(angle => 
                    Math.abs(currentAngle - angle) < this.config.angleThreshold
                );
                
                // Prevent duplicate samples
                if (this.lastLoggedAngle === targetAngle) {
                    return;
                }
                
                // Prevent memory leak
                if (this.performanceData.length >= this.config.maxSamples) {
                    this.performanceData.shift();
                }
                
                const timestamp = performance.now();
                const shaderInfo = this.getCurrentShaderInfo();
                
                const logEntry = {
                    timeSeconds: parseFloat((timestamp / 1000).toFixed(1)),
                    timestampMs: parseFloat(timestamp.toFixed(2)),
                    frameTime: parseFloat(this.frameTime.toFixed(2)),
                    fps: parseFloat(this.fps.toFixed(1)),
                    meshCount: this.meshCount,
                    rotationAngle: targetAngle,
                    scale: this.currentScale,
                    cycleNumber: this.completedCycles
                };

                // Only include shader info if changed
                if (shaderInfo.name !== this.lastShaderName || 
                    JSON.stringify(shaderInfo.params) !== JSON.stringify(this.lastShaderParams)) {
                    logEntry.shaderName = shaderInfo.name;
                    logEntry.shaderParams = shaderInfo.params;
                    this.lastShaderName = shaderInfo.name;
                    this.lastShaderParams = shaderInfo.params;
                }
                
                this.performanceData.push(logEntry);
                this.lastLoggedAngle = targetAngle;
                
                console.log(`Sample at ${targetAngle}° - FPS: ${logEntry.fps}, Scale: ${this.currentScale}, Cycle: ${this.completedCycles}`);
            } else {
                // Reset when between target angles
                const resetAngles = [0, 180, 360];
                if (resetAngles.some(angle => Math.abs(currentAngle - angle) < this.config.angleThreshold)) {
                    this.lastLoggedAngle = null;
                }
            }
        }, this.config.sampleInterval);
    }

    startCycleMonitoring() {
        if (this.cycleCheckInterval) {
            clearInterval(this.cycleCheckInterval);
        }

        this.cycleCheckInterval = setInterval(() => {
            if (!this.carousel) {
                return;
            }
            
            if (this.maxMeshCount === null) {
                this.maxMeshCount = this.carousel.data.maxCount || 5;
                console.log(`Carousel maxCount: ${this.maxMeshCount}`);
            }
            
            if (this.meshCount >= this.maxMeshCount) {
                if (!this.meshCountReached && !this.cycleCompleteTimer) {
                    this.meshCountReached = true;
                    console.log(`Mesh count reached (${this.meshCount}/${this.maxMeshCount}), waiting ${this.config.cycleDelay / 1000}s...`);
                    
                    this.cycleCompleteTimer = setTimeout(() => {
                        this.onCycleComplete();
                        this.meshCountReached = false;
                        this.cycleCompleteTimer = null;
                    }, this.config.cycleDelay);
                }
            } else {
                if (this.meshCountReached) {
                    console.log(`Mesh count dropped, resetting timer`);
                    if (this.cycleCompleteTimer) {
                        clearTimeout(this.cycleCompleteTimer);
                        this.cycleCompleteTimer = null;
                    }
                    this.meshCountReached = false;
                }
            }
        }, 100);
    }

    onCycleComplete() {
        this.completedCycles++;
        console.log(`✓ Cycle ${this.completedCycles} completed`);
        
        if (this.completedCycles >= this.config.targetCycles) {
            console.log(`✓ All ${this.config.targetCycles} cycles completed!`);
            this.proposeDownload();
        } else {
            this.currentScaleIndex++;
            if (this.currentScaleIndex < this.config.scales.length) {
                this.currentScale = this.config.scales[this.currentScaleIndex];
                console.log(`→ Changing to scale ${this.currentScale}`);
                
                this.recreateCarousel();

                this.showNotification(`Scale ${this.currentScale} - Cycle ${this.completedCycles + 1}/${this.config.targetCycles}`, 2000);
            }
        }
    }

    async recreateCarousel() {
        const scene = document.querySelector('a-scene');
        const oldCarousel = this.carouselEntity;
        
        if (!oldCarousel || !scene) {
            console.error('Carousel or scene not found');
            return;
        }

        console.log(`� Recreating carousel at scale ${this.currentScale}`);

        // Save configuration
        const carouselConfig = oldCarousel.getAttribute('carousel');
        
        // Use the original template info that we captured at startup
        // This ensures we always have the correct template, not a cloned entity
        if (!this.originalTemplateInfo) {
            console.error('Original template info not available! Cannot recreate carousel.');
            return;
        }

        console.log('Using original template info:', this.originalTemplateInfo);

        // Dispose and remove old carousel
        this.disposeEntityTree(oldCarousel);
        oldCarousel.parentNode.removeChild(oldCarousel);

        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 100));

        // Build a fresh template from the captured original info
        const freshTemplate = document.createElement(this.originalTemplateInfo.tagName);
        freshTemplate.setAttribute('radius', this.originalTemplateInfo.radius);

        // Parse original shader attr and inject the new scale
        const pairs = this.originalTemplateInfo.shaderAttr.split(';').map(s => s.trim()).filter(s => s);
        const params = {};
        pairs.forEach(pair => {
            const [key, ...valueParts] = pair.split(':');
            const value = valueParts.join(':').trim();
            if (key && value) params[key.trim()] = value;
        });
        params.scale = this.currentScale.toString();

        const newShaderAttr = Object.entries(params)
            .map(([key, value]) => `${key}: ${value}`)
            .join('; ');
        freshTemplate.setAttribute('tsl-shader', newShaderAttr);

        // Order matters: template must be appended before carousel attribute is set
        const newCarousel = document.createElement('a-entity');
        newCarousel.appendChild(freshTemplate);
        newCarousel.setAttribute('carousel', carouselConfig);
        scene.appendChild(newCarousel);

        // Refresh cached refs
        await new Promise(resolve => setTimeout(resolve, 50));
        this.updateCarouselReferences();

        console.log(`✓ Carousel recreated with scale ${this.currentScale}`);
    }

    disposeEntityTree(entity) {
        if (!entity) return;

        const allEntities = [entity, ...entity.querySelectorAll('*')];
        let disposedCount = 0;

        allEntities.forEach(el => {
            if (el.object3D) {
                el.object3D.traverse((obj) => {
                    if (obj.geometry && obj.geometry.dispose) {
                        obj.geometry.dispose();
                    }

                    if (obj.material) {
                        if (Array.isArray(obj.material)) {
                            obj.material.forEach(mat => this.disposeMaterialAndTextures(mat));
                        } else {
                            this.disposeMaterialAndTextures(obj.material);
                        }
                    }
                });

                if (el.object3D.parent) {
                    el.object3D.parent.remove(el.object3D);
                }

                disposedCount++;
            }

            if (el.components) {
                Object.keys(el.components).forEach(name => {
                    if (el.components[name].remove) {
                        el.components[name].remove();
                    }
                });
            }
        });

        console.log(`  Disposed ${disposedCount} entities`);
    }

    disposeMaterialAndTextures(material) {
        if (!material) return;

        const textureProperties = [
            'map', 'lightMap', 'bumpMap', 'normalMap', 'specularMap',
            'envMap', 'alphaMap', 'aoMap', 'displacementMap', 'emissiveMap',
            'gradientMap', 'metalnessMap', 'roughnessMap'
        ];

        textureProperties.forEach(prop => {
            if (material[prop] && material[prop].dispose) {
                material[prop].dispose();
            }
        });

        if (material.dispose) {
            material.dispose();
        }
    }

    proposeDownload() {
        // Stop all monitoring
        if (this.logInterval) {
            clearInterval(this.logInterval);
            this.logInterval = null;
        }
        
        if (this.cycleCheckInterval) {
            clearInterval(this.cycleCheckInterval);
            this.cycleCheckInterval = null;
        }

        // Make UI clickable
        Object.assign(this.uiElement.style, {
            cursor: 'pointer',
            backgroundColor: 'rgba(76, 175, 80, 0.8)',
            border: '2px solid #4CAF50'
        });
        
        this.uiElement.addEventListener('click', () => this.downloadStats(), { once: true });
        
        // Update UI
        const clickPrompt = document.createElement('div');
        clickPrompt.innerHTML = '<br><small>📊 Click to download stats</small>';
        this.uiElement.appendChild(clickPrompt);
        
        this.showNotification(`${this.config.targetCycles} cycles completed! Click to download stats.`);
    }

    downloadStats() {
        try {
            if (this.uiElement.style.cursor === 'not-allowed') {
                return;
            }
            
            Object.assign(this.uiElement.style, {
                cursor: 'not-allowed',
                backgroundColor: 'rgba(255, 152, 0, 0.8)'
            });
            
            this.uiElement.querySelector('small').textContent = '⬇️ Downloading...';
            
            // Calculate statistics per scale
            const scaleStats = {};
            this.config.scales.forEach(scale => {
                const scaleData = this.performanceData.filter(entry => entry.scale === scale);
                if (scaleData.length > 0) {
                    const fps = scaleData.map(e => e.fps);
                    const frameTime = scaleData.map(e => e.frameTime);
                    
                    scaleStats[`scale_${scale}`] = {
                        scale: scale,
                        sampleCount: scaleData.length,
                        averageFPS: parseFloat((fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(1)),
                        averageFrameTime: parseFloat((frameTime.reduce((a, b) => a + b, 0) / frameTime.length).toFixed(2)),
                        minFPS: parseFloat(Math.min(...fps).toFixed(1)),
                        maxFPS: parseFloat(Math.max(...fps).toFixed(1)),
                        standardDeviationFPS: this.calculateStdDev(fps)
                    };
                }
            });
            
            const allFPS = this.performanceData.map(e => e.fps);
            const allFrameTime = this.performanceData.map(e => e.frameTime);
            
            const stats = {
                metadata: {
                    version: '2.0',
                    generatedAt: new Date().toISOString(),
                    configuration: this.config
                },
                summary: {
                    totalSamples: this.performanceData.length,
                    completedCycles: this.completedCycles,
                    scalesUsed: this.config.scales,
                    durationSeconds: this.performanceData.length > 0 ? 
                        parseFloat((this.performanceData[this.performanceData.length - 1].timeSeconds - this.performanceData[0].timeSeconds).toFixed(1)) : 0,
                    overallAverageFPS: parseFloat((allFPS.reduce((a, b) => a + b, 0) / allFPS.length).toFixed(1)),
                    overallAverageFrameTime: parseFloat((allFrameTime.reduce((a, b) => a + b, 0) / allFrameTime.length).toFixed(2)),
                    minFPS: parseFloat(Math.min(...allFPS).toFixed(1)),
                    maxFPS: parseFloat(Math.max(...allFPS).toFixed(1)),
                    standardDeviationFPS: this.calculateStdDev(allFPS)
                },
                scaleStatistics: scaleStats,
                samples: this.performanceData
            };

            const dataStr = JSON.stringify(stats, null, 2);
            const dataBlob = new Blob([dataStr], {type: 'application/json'});
            const url = URL.createObjectURL(dataBlob);
            
            const link = document.createElement('a');
            link.href = url;
            link.download = `perf-stats-${this.config.scales.join('-')}-${Date.now()}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            
            setTimeout(() => {
                this.uiElement.style.backgroundColor = 'rgba(33, 150, 243, 0.8)';
                this.uiElement.querySelector('small').textContent = '✅ Downloaded';
                this.showNotification('Stats downloaded successfully!');
            }, 500);
        } catch (error) {
            console.error('Download failed:', error);
            this.showNotification('Error downloading stats. Check console.', 5000);
            Object.assign(this.uiElement.style, {
                cursor: 'pointer',
                backgroundColor: 'rgba(244, 67, 54, 0.8)'
            });
            this.uiElement.querySelector('small').textContent = '❌ Error - Try again';
        }
    }

    calculateStdDev(values) {
        if (values.length === 0) return 0;
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length;
        return parseFloat(Math.sqrt(variance).toFixed(2));
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
            fontFamily: 'Arial, sans-serif',
            fontSize: '16px',
            zIndex: '10000',
            maxWidth: '300px',
            textAlign: 'center',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.3)'
        });
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, duration);
    }
}

// Initialize with optional configuration
document.addEventListener('DOMContentLoaded', () => {
    // Example with custom configuration:
    // const profiler = new VRProfiler({
    //     scales: [1, 2, 4, 8],
    //     targetCycles: 5,
    //     sampleAngles: [0, 90, 180, 270],
    //     cycleDelay: 5000
    // });
    
    const profiler = new VRProfiler();
});
