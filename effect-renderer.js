// Ensure Three.js is loaded first, e.g., via CDN in index.html
// <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>

let effectData = null;
let effectLayers = []; // Declare outside init
let screenPlane = null; // Make screen plane accessible
let renderer = null;    // Make renderer accessible
let scene = null;       // Make scene accessible
let camera = null;      // Make camera accessible
let renderTargets = { input: null, output: null }; // Simple ping-pong FBOs

if (typeof THREE === 'undefined') {
    console.error('Three.js library is not loaded.');
    // Add fallback or error handling here
} else {
    fetch('./demoscript.json')
        .then(response => {
            if (!response.ok) {
                console.error(`HTTP error! status: ${response.status}`, response);
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            // Clone the response to read it twice (once as text, once as json)
            return response.clone().text().then(text => {
                 console.log("Raw response text:", text); // Log raw text
                 if (!text) {
                     throw new Error("Received empty response");
                 }
                 // Now parse the original response as JSON
                 return response.json(); 
            });
        })
        .then(data => {
            effectData = data;
            console.log('Effect data loaded:', effectData);
            init(); // Initialize Three.js setup after data is loaded
        })
        .catch(error => {
            console.error('Error loading or parsing demoscript.json:', error);
        });
}

function createEffectLayers(history, rendererInstance) {
    const layers = [];
    const textureLoader = new THREE.TextureLoader();
    const size = new THREE.Vector2();
    rendererInstance.getSize(size);

    history.forEach((layerData, index) => {
        console.log(`Processing layer ${index}: ${layerData.type}`);
        const layer = {
            type: layerData.type,
            visible: layerData.visible !== false, // Default to true if undefined
            materials: [],
            uniforms: {},
            passInfo: layerData.data?.passes || [], // Info for multi-pass effects
            needsBgTexture: false, // Flag if uBgTexture is used
            // Add more properties as needed (breakpoints, states)
        };

        // --- Define Uniforms (Including textures) ---
        layer.uniforms = {
            // Common uniforms we might need
            uTime: { value: 0.0 },
            uResolution: { value: new THREE.Vector2(size.x, size.y) },
            uMousePos: { value: new THREE.Vector2(0.5, 0.5) }, // Normalized 0-1
            // Textures - will be assigned during render pipeline
            uTexture: { value: null }, 
            uBgTexture: { value: null }, 
        };

        // Add uniforms specific to this layer type from layerData.data.uniforms
        if (layerData.data?.uniforms) {
            for (const key in layerData.data.uniforms) {
                const uniformData = layerData.data.uniforms[key];
                let uniformValue;
                switch (uniformData.type) {
                    case '1f':
                        uniformValue = uniformData.value;
                        break;
                    case '2f':
                        if (uniformData.value.type === 'Vec2') {
                             uniformValue = new THREE.Vector2(uniformData.value._x, uniformData.value._y);
                        } else {
                             uniformValue = new THREE.Vector2(uniformData.value[0], uniformData.value[1]); // Assuming array
                        }
                        break;
                    // Add cases for other types like '3f', '4f', 'sampler2D' etc. if needed
                    default:
                        console.warn(`Unhandled uniform type: ${uniformData.type} for key: ${key}`);
                        uniformValue = uniformData.value; // Assign directly, might need adjustment
                }
                layer.uniforms[uniformData.name] = { value: uniformValue };
            }
        }
        
        // --- TODO: Incorporate initial values from layerData properties ---
        // e.g., layer.uniforms.uSpeed.value = layerData.speed;

        // --- Create Shader Materials --- 
        // 1. Extract Vertex Shader Source
        const vertexShaderSource = layerData.compiledVertexShaders[0]; 
        if (!vertexShaderSource) {
             console.error(`Layer ${index} (${layerData.type}) missing vertex shader source.`);
             return; // Skip layer if no VS
        }
        
        if (layerData.compiledFragmentShaders && layerData.compiledFragmentShaders.length > 0) {
            // 2. Extract Fragment Shader Sources and Create Materials
            layerData.compiledFragmentShaders.forEach((fragmentShaderSource, passIndex) => {
                if (!fragmentShaderSource) {
                    console.error(`Layer ${index} (${layerData.type}), pass ${passIndex} missing fragment shader source.`);
                    return; 
                }

                // Check if this fragment shader uses uBgTexture
                if (fragmentShaderSource.includes('uBgTexture')) {
                    layer.needsBgTexture = true;
                }

                // 3. Create Material using extracted sources
                const material = new THREE.ShaderMaterial({
                    vertexShader: vertexShaderSource,   // Use extracted VS
                    fragmentShader: fragmentShaderSource, // Use extracted FS
                    uniforms: layer.uniforms,
                    transparent: true, 
                    depthWrite: false,
                    depthTest: false
                });
                layer.materials.push(material);
            });
        } else {
            console.error(`Layer ${index} (${layerData.type}) has no fragment shaders.`);
        }

        // --- TODO: Handle custom textures --- 
        if (layerData.texture?.src) {
            console.log("Loading texture:", layerData.texture.src);
            const customTexture = textureLoader.load(layerData.texture.src);
            // Assign texture to the correct uniform (e.g., uCustomTexture)
            const uniformName = layerData.texture.sampler || 'uCustomTexture'; // Default name
            layer.uniforms[uniformName] = { value: customTexture };
        }

        if (layer.materials.length > 0) {
            layers.push(layer);
        } else {
            console.warn(`Layer ${index} (${layerData.type}) was skipped due to missing shaders.`);
        }
    });

    return layers;
}

function createRenderTargets(rendererInstance) {
    const size = new THREE.Vector2();
    rendererInstance.getSize(size);
    const options = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType // Or FloatType if needed
    };
    renderTargets.input = new THREE.WebGLRenderTarget(size.x, size.y, options);
    renderTargets.output = new THREE.WebGLRenderTarget(size.x, size.y, options);
}

function swapRenderTargets() {
    const temp = renderTargets.input;
    renderTargets.input = renderTargets.output;
    renderTargets.output = temp;
}

function init() {
    if (!effectData) {
        console.error("Effect data not available for initialization.");
        return;
    }

    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1; // Position doesn't matter much for ortho with shaders

    const canvas = document.querySelector('canvas');
    if (!canvas) {
        console.error('Canvas element not found!');
        return;
    }
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // Create render targets *after* renderer is initialized
    createRenderTargets(renderer); 

    const geometry = new THREE.PlaneGeometry(2, 2); // Covers view coords -1 to 1
    screenPlane = new THREE.Mesh(geometry); // Material will be set per layer/pass
    scene.add(screenPlane); 

    effectLayers = createEffectLayers(effectData.history, renderer);
    console.log("Processed effect layers:", effectLayers);

    if (effectLayers.length === 0) {
        console.error("No effect layers were created successfully.");
        screenPlane.material = new THREE.MeshBasicMaterial({ color: 0xff0000 }); // Red error indicator
    }

    // Handle Window Resize
    window.addEventListener('resize', onWindowResize, false);

    function onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        renderer.setSize(width, height);
        
        // Resize render targets
        renderTargets.input.setSize(width, height);
        renderTargets.output.setSize(width, height);

        effectLayers.forEach(layer => {
            if (layer.uniforms.uResolution) {
                layer.uniforms.uResolution.value.set(width, height);
            }
            // Removed breakpoint TODO
        });
    }

    // Mouse Position Uniform
    const mousePosition = new THREE.Vector2(0.5, 0.5);
    window.addEventListener('mousemove', (event) => {
        mousePosition.x = event.clientX / window.innerWidth;
        mousePosition.y = 1.0 - event.clientY / window.innerHeight; // Invert Y
    });

    // Render Loop
    const clock = new THREE.Clock();

    function animate() {
        requestAnimationFrame(animate);
        const elapsedTime = clock.getElapsedTime();

        // --- Update Uniforms --- 
        effectLayers.forEach(layer => {
            if (!layer.visible) return;
            if (layer.uniforms.uTime) {
                layer.uniforms.uTime.value = elapsedTime;
            }
            if (layer.uniforms.uMousePos) {
                // Only update if the layer uses mouse tracking (based on original JSON)
                // TODO: Add check based on layerData.trackMouse or similar
                layer.uniforms.uMousePos.value.copy(mousePosition);
            }
            // --- TODO: Update uniforms based on states (appear, scroll, hover) ---
            // Removed breakpoint TODO
        });

        // --- Render Pipeline --- 
        if (effectLayers.length > 0) {
            renderer.setRenderTarget(renderTargets.output); // Start with the first output target
            renderer.clear();
            
            let lastOutputTexture = null; // Keep track of the input for uBgTexture

            effectLayers.forEach((layer, layerIndex) => {
                if (!layer.visible) return;

                // --- Handle Passes --- 
                // Simplified: assuming 1 material per layer for now
                // TODO: Expand to handle layer.passInfo and multiple materials/passes
                const material = layer.materials[0]; 
                if (!material) return;

                screenPlane.material = material;
                
                // Assign input texture (output of previous layer)
                material.uniforms.uTexture.value = renderTargets.input.texture;
                
                // Assign background texture if needed (original input before this layer)
                if (layer.needsBgTexture) {
                     material.uniforms.uBgTexture.value = lastOutputTexture;
                }

                // Determine target: screen or next render target
                const isLastLayer = layerIndex === effectLayers.length - 1;
                if (isLastLayer) {
                    renderer.setRenderTarget(null); // Render to screen
                } else {
                    renderer.setRenderTarget(renderTargets.output);
                    renderer.clear(); // Clear if rendering to an FBO
                }

                renderer.render(scene, camera);

                // Prepare for next layer
                if (!isLastLayer) {
                     lastOutputTexture = renderTargets.input.texture; // Store the input for potential uBgTexture use
                     swapRenderTargets(); // Output becomes input for the next iteration
                }
            });

        } else {
            // Render the error indicator if no layers loaded
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);
        }
    }

    // Initial resize call
    onWindowResize(); 
    // Start animation
    animate();

    // Final TODOs:
    // 1. Refine Render Pipeline (Multi-pass, PingPong FBOs if needed)
    // 2. Handle States (animations/interactions)
    // 3. Refine Uniform Handling (initial values, types, trackMouse check)
    // 4. Load custom textures (sdf_shape)
} 