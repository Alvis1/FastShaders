// ShaderLoader03.js - TSL Shader Component for A-Frame WebGPU
// Simple loader for TSL shaders

import AFRAME from 'aframe';
import * as THREE from 'three';

AFRAME.registerComponent('tsl-shader', {
    schema: {
        type: 'string'
    },
    
    multiple: true,
    
    init() {
        console.log('[tsl-shader] Component init on:', this.el.tagName, 'with attribute:', this.el.getAttribute('tsl-shader'));
        this.setupMaterial();
    },
        
        async setupMaterial() {
            const attrValue = this.el.getAttribute('tsl-shader');
            console.log('[tsl-shader] setupMaterial called with:', attrValue);
            
            // Parse the attribute string manually
            const params = {};
            if (typeof attrValue === 'string') {
                const pairs = attrValue.split(';').map(s => s.trim()).filter(s => s);
                pairs.forEach(pair => {
                    const [key, ...valueParts] = pair.split(':');
                    const value = valueParts.join(':').trim();
                    if (key && value) {
                        params[key.trim()] = value;
                    }
                });
            }
            
            const src = params.src || 'polka-dots';
            const roughness = parseFloat(params.roughness) || 0.5;
            const metalness = parseFloat(params.metalness) || 0.0;
            
            try {
                let shaderPath, shaderFunctionName;
                
                if (src.includes('/') || src.endsWith('.js')) {
                    shaderPath = src;
                    const filename = src.split('/').pop().replace('.js', '');
                    shaderFunctionName = this.kebabToCamel(filename);
                } else {
                    shaderPath = `./tsl/${src}.js`;
                    shaderFunctionName = this.kebabToCamel(src);
                }
                
                const shaderModule = await import(shaderPath);
                console.log('[tsl-shader] Loaded shader module from:', shaderPath);
                let shaderFunction = shaderModule[shaderFunctionName];
                
                if (!shaderFunction) {
                    const alternatives = [src, src.toLowerCase(), 'default'];
                    for (const alt of alternatives) {
                        if (shaderModule[alt]) {
                            shaderFunction = shaderModule[alt];
                            break;
                        }
                    }
                }
                
                if (!shaderFunction) {
                    console.error(`Shader function not found: ${shaderFunctionName}`);
                    return;
                }
                
                const material = new THREE.MeshStandardNodeMaterial({
                    roughness: roughness,
                    metalness: metalness
                });
                
                // Pass all parameters except src, roughness, metalness to the shader
                const shaderParams = {};
                Object.keys(params).forEach(key => {
                    if (key !== 'src' && key !== 'roughness' && key !== 'metalness') {
                        const value = params[key];
                        // Try to parse as number
                        const numValue = parseFloat(value);
                        if (!isNaN(numValue) && value.trim() === numValue.toString()) {
                            shaderParams[key] = numValue;
                        } 
                        // Check if it's a color (starts with #)
                        else if (value.startsWith('#')) {
                            shaderParams[key] = new THREE.Color(value);
                        }
                        // Check if it's comma-separated RGB values (e.g., "0.8,0.4,0")
                        else if (value.includes(',')) {
                            const parts = value.split(',').map(s => parseFloat(s.trim()));
                            if (parts.length === 3 && parts.every(p => !isNaN(p))) {
                                shaderParams[key] = new THREE.Color(parts[0], parts[1], parts[2]);
                            } else {
                                shaderParams[key] = value;
                            }
                        }
                        // Otherwise keep as string
                        else {
                            shaderParams[key] = value;
                        }
                    }
                });
                
                material.colorNode = shaderFunction(shaderParams);
                this.applyMaterial(material);
                
            } catch (error) {
                console.error('Error loading TSL shader:', error);
            }
        },
        
        applyMaterial(material) {
            const mesh = this.el.getObject3D('mesh');
            if (mesh) {
                mesh.material = material;
                mesh.material.needsUpdate = true;
            } else {
                this.el.addEventListener('object3dset', () => {
                    const newMesh = this.el.getObject3D('mesh');
                    if (newMesh) {
                        newMesh.material = material;
                        newMesh.material.needsUpdate = true;
                    }
                });
            }
    },
    
    kebabToCamel(str) {
        return str.replace(/-([a-z])/g, function (g) { 
            return g[1].toUpperCase(); 
        });
    },
    
    update() {
        console.log('[tsl-shader] update() called, reloading shader');
        this.setupMaterial();
    }
});
