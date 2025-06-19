import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

let scene, camera, renderer, clock, mixer, head;
const animationActions = new Map();
let activeAction;
let isSpeaking = false; // To track speech state


const animationNames = [
    'Seated Idle',
    'Sitting Talking',
    'Sitting Clap',
    'Sitting Disapproval',
];

const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const userInput = document.getElementById('user-input');
const chatLog = document.getElementById('chat-log');
const chatContainer = document.getElementById('chat-container');
const startBtn = document.getElementById('start-btn');


init();

async function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x33334d);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 1.3, 2.2);
    camera.lookAt(0, 1.0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
    hemiLight.position.set(0, 20, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(3, 10, 10);
    scene.add(dirLight);

    clock = new THREE.Clock();

    // Attach UI handlers immediately so the app is responsive.
    sendBtn.addEventListener('click', handleUserInput);
    userInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') handleUserInput();
    });
    micBtn.addEventListener('click', handleVoiceInput);
    window.addEventListener('resize', onWindowResize, false);

    // Load avatar and animations. The start button logic is inside here.
    loadAvatar();

    // Start the animation loop.
    animate();
}



function loadAvatar() {
    const gltfLoader = new GLTFLoader();
    gltfLoader.load('./assets/models/avatar.glb', 
        (gltf) => {
            const model = gltf.scene;
            model.scale.set(1, 1, 1);
            model.position.set(0, 0, 0);
            scene.add(model);

            head = model.getObjectByName('Wolf3D_Head');

            mixer = new THREE.AnimationMixer(model);
            loadAnimations();
        }, 
        undefined, 
        (error) => {
            console.error('An error happened while loading the avatar:', error);
            addMessageToLog('Error: Could not load avatar model. Please check asset paths and server configuration.', 'avatar');
        }
    );
}

function loadAnimations() {
    const fbxLoader = new FBXLoader();
    const animationPromises = animationNames.map(name => {
        return new Promise((resolve, reject) => {
            fbxLoader.load(`./assets/animations/${name}.fbx`, 
                (anim) => {
                    const action = mixer.clipAction(anim.animations[0]);
                    if (name === 'Sitting Clap' || name === 'Sitting Disapproval') {
                        action.setLoop(THREE.LoopOnce);
                        action.clampWhenFinished = true;
                    }
                    animationActions.set(name, action);
                    resolve();
                }, 
                undefined, 
                (error) => {
                    console.error(`Failed to load animation: ${name}`, error);
                    reject(new Error(`Failed to load animation: ${name}`));
                }
            );
        });
    });

    Promise.all(animationPromises).then(() => {
        playAction('Seated Idle');
        startBtn.addEventListener('click', () => {
            startBtn.classList.add('hidden');
            startIntroduction();
            

        }, { once: true });
    }).catch(error => {
        console.error("Error loading animations:", error);
        addMessageToLog('Error: Could not load all animations. The application may not function correctly.', 'avatar');
    });
}

function playAction(name) {
    const newAction = animationActions.get(name);
    if (!newAction || newAction === activeAction) return;

    if (activeAction) {
        mixer.removeEventListener('finished', returnToIdle);
        activeAction.fadeOut(0.5);
    }

    newAction.reset().fadeIn(0.5).play();
    activeAction = newAction;

    if (newAction.loop !== THREE.LoopRepeat) {
        mixer.addEventListener('finished', returnToIdle);
    }
}

function returnToIdle() {
    if (activeAction.loop !== THREE.LoopRepeat) {
        playAction('Seated Idle');
    }
}

function speak(text, onEndCallback) {
    const utterance = new SpeechSynthesisUtterance(text);
    
    utterance.onstart = () => {
        playAction('Sitting Talking');
        isSpeaking = true;
    };

    utterance.onend = () => {
        isSpeaking = false;
        if (head && head.morphTargetDictionary) {
            const mouthOpenTarget = head.morphTargetDictionary['viseme_aa'];
            if (mouthOpenTarget !== undefined) {
                 head.morphTargetInfluences[mouthOpenTarget] = 0;
            }
        }
        playAction('Seated Idle');
        if (onEndCallback) {
            onEndCallback();
        }
    };

    speechSynthesis.speak(utterance);
}

function startIntroduction() {
    const greeting = "Hello Yassine, welcome to our live interview.";
    speak(greeting, () => {
        chatContainer.classList.add('visible');
        startInterview();
    });
}

function startInterview() {
    addMessageToLog("Hello Yassine, welcome to our live interview.", 'avatar');
    const question = "Let's start with your first question. What is Three.js?";
    
    setTimeout(() => {
        addMessageToLog(question, 'avatar');
        speak(question);
    }, 500);
}

function handleUserInput() {
    const message = userInput.value.trim();
    if (!message) return;

    addMessageToLog(message, 'user');
    userInput.value = '';

    processAnswer(message);
}

function processAnswer(answer) {
    const isCorrect = answer.toLowerCase().includes('three.js');

    let responseMessage;
    if (isCorrect) {
        responseMessage = "That's a great answer! Well done.";
        playAction('Sitting Clap');
    } else {
        responseMessage = "That's not quite right. Let's try another question.";
        playAction('Sitting Disapproval');
    }

    setTimeout(() => {
        addMessageToLog(responseMessage, 'avatar');
        speak(responseMessage);
    }, 1500);
}

function handleVoiceInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert("Sorry, your browser doesn't support speech recognition.");
        return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.start();

    micBtn.classList.add('active');

    recognition.onresult = (event) => {
        const speechResult = event.results[0][0].transcript;
        userInput.value = speechResult;
        handleUserInput();
    };

    recognition.onspeechend = () => {
        recognition.stop();
        micBtn.classList.remove('active');
    };

    recognition.onerror = (event) => {
        alert(`Error occurred in recognition: ${event.error}`);
        micBtn.classList.remove('active');
    };
}

function addMessageToLog(message, sender) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', `${sender}-message`);
    messageElement.textContent = message;
    chatLog.appendChild(messageElement);
    chatLog.scrollTop = chatLog.scrollHeight;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);

    if (head && isSpeaking) {
        const time = Date.now();
        const mouthOpen = (Math.sin(time * 0.01) + 1) / 2; // Simple sine wave for mouth movement
        const mouthOpenTarget = head.morphTargetDictionary['viseme_aa'];
        if (mouthOpenTarget !== undefined) {
            head.morphTargetInfluences[mouthOpenTarget] = mouthOpen * 0.5;
        }
    }

    renderer.render(scene, camera);
}


