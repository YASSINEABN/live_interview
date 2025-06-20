import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as pdfjsLib from 'pdfjs-dist';

// --- Constants for tuning ---
let OPENROUTER_API_KEY = ''; // Will be set at runtime for security
const API_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const FACE_DETECTION_INTERVAL = 500; // ms
const STRESSED_THRESHOLD = 0.3; // Increased sensitivity
const EXPRESSION_SMOOTHING = 0.2;
const ANGRY_THRESHOLD = 0.5; // Increased sensitivity
const EAR_THRESHOLD = 0.22; // Eye Aspect Ratio threshold for closed eyes
const EYE_CLOSED_DURATION = 3000; // ms to be considered sleeping
const ATTENTION_THRESHOLD = 0.35; // Head rotation threshold (more sensitive)
const USER_MISSING_DURATION = 2500; // ms to be considered missing
const LOOKING_AWAY_DURATION = 3000; // ms to be considered looking away

// --- Scene and 3D objects ---
let scene, camera, renderer, clock, mixer, head;
const animationActions = new Map();
let activeAction;

// --- State variables ---
let eyesClosedSince = null;
let lookingAwaySince = null;
let userMissingSince = null;
let faceDetectionIntervalId = null;
let smoothedExpressions = {};
let currentState = 'neutral'; // Single source of truth for avatar's state
let stateLock = false; // Prevents spamming state-based messages
let modelsLoadedPromise = null;
let candidateName = null;
let resumeText = null;
let currentUtterance = null; // Prevents premature garbage collection of speech utterance
let jobDescription = null;
let jobLink = null;
let githubLink = null;
let linkedinLink = null;

// --- Interview & Prompt State ---
let promptTemplates = {};
let interviewState = {
    questionNumber: 0,
    totalQuestions: 10,
    conversationHistory: [],
    isFinished: false,
    candidateName: ''
};
let isSpeaking = false;
let visemeAnimationId = null; // For mouth animation

// --- Voice Recognition State ---
let recognition;
let isRecognizing = false;

const animationNames = [
    'Seated Idle',
    'Having A Meeting',
    'Sitting Talking',
    'Sitting Clap',
    'Sitting Disapproval',
    'Asking Question',
];

// --- DOM Elements ---
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const userInput = document.getElementById('user-input');
const chatLog = document.getElementById('chat-log');
const chatContainer = document.getElementById('chat-container');
const startBtn = document.getElementById('start-btn');
const video = document.getElementById('video');

// --- New Setup Flow DOM Elements ---
const setupContainer = document.getElementById('setup-container');
const initialChoice = document.getElementById('initial-choice');
const jobPrepBtn = document.getElementById('job-prep-btn');
const resumePrepBtn = document.getElementById('resume-prep-btn');
const jobPrepForm = document.getElementById('job-prep-form');
const resumePrepForm = document.getElementById('resume-prep-form');
const jobDescriptionInput = document.getElementById('job-description');
const jobLinkInput = document.getElementById('job-link');
const githubLinkInput = document.getElementById('github-link');
const linkedinLinkInput = document.getElementById('linkedin-link');
const resumeUploadJob = document.getElementById('resume-upload-job');
const resumeUploadGeneral = document.getElementById('resume-upload-general');

// --- Initialization ---
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs`;

// --- API Key Configuration ---
// 1. IMPORTANT: You MUST replace the placeholder below with your new, valid OpenRouter API key.
// 2. WARNING: Hardcoding keys is insecure and for LOCAL TESTING ONLY. Do not commit this to a public repository.
OPENROUTER_API_KEY = "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";



async function loadPrompts() {
    try {
        const response = await fetch('./prompts.json');
        if (!response.ok) {
            throw new Error('prompts.json file not found.');
        }
        promptTemplates = await response.json();
    } catch (error) {
        console.error("Failed to load prompts:", error);
        alert("Critical error: Could not load prompt templates. The application cannot continue.");
    }
}

function onWindowResize() {
    if (camera && renderer) {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }
}

async function handleUserInput() {
    const userMessage = userInput.value.trim();
    if (!userMessage || isSpeaking) return;

    addMessageToLog(userMessage, 'user');
    userInput.value = '';
    userInput.disabled = true;
    sendBtn.disabled = true;
    micBtn.disabled = true;

    interviewState.conversationHistory.push({ role: 'user', content: userMessage });

    try {
        if (interviewState.isFinished) {
            await getFinalEvaluation();
        } else {
            await askNextQuestion();
        }
    } catch (error) {
        console.error("Error during interview step:", error);
        await speak("I've encountered an error. Let's try that again.");
    } finally {
        // Re-enable controls unless the interview is finished
        if (!interviewState.isFinished) {
            userInput.disabled = false;
            sendBtn.disabled = false;
            micBtn.disabled = false;
            userInput.focus();
        }
    }
}

async function handleResumeUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const label = event.target.previousElementSibling;
    label.textContent = 'Processing...';
    label.style.pointerEvents = 'none';

    try {
        const fileReader = new FileReader();
        if (file.type === "application/pdf") {
            fileReader.onload = async function() {
                try {
                    const typedarray = new Uint8Array(this.result);
                    const pdf = await pdfjsLib.getDocument({data: typedarray}).promise;
                    let fullText = '';
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const textContent = await page.getTextContent();
                        const pageText = textContent.items.map(item => item.str).join(' ');
                        fullText += pageText + '\n';
                    }
                    handleResumeData(fullText);
                } catch (error) {
                    console.error('Error parsing PDF:', error);
                    addMessageToLog('Error: Could not read the resume. Please try another PDF file.', 'system');
                    label.textContent = 'Upload Failed. Try Again.';
                    label.style.pointerEvents = 'auto';
                }
            };
            fileReader.readAsArrayBuffer(file);
        } else if (file.type === "text/plain") {
            fileReader.onload = (e) => handleResumeData(e.target.result);
            fileReader.readAsText(file);
        } else {
            addMessageToLog('Unsupported file type. Please upload a PDF or TXT file.', 'system');
            label.textContent = 'Upload Resume';
            label.style.pointerEvents = 'auto';
        }
    } catch (error) {
        console.error('Error reading file:', error);
        addMessageToLog('Error: Could not read the file.', 'system');
        label.textContent = 'Upload Failed. Try Again.';
        label.style.pointerEvents = 'auto';
    }
}

function handleResumeData(text) {
    resumeText = text;
    interviewState.candidateName = extractCandidateName(text);
    const displayName = interviewState.candidateName || 'candidate';
    addMessageToLog(`Resume for ${displayName} loaded successfully. You can now start the interview.`, 'system');
    
    const label = document.querySelector('label[for="resume-upload-general"]');
    if (label) {
        label.textContent = 'Resume Uploaded';
        label.style.pointerEvents = 'auto';
    }
    startBtn.disabled = false;
    startBtn.classList.remove('hidden'); // Make the button visible
}

function extractCandidateName(text) {
    if (!text) return 'the candidate';
    const lines = text.split('\n').slice(0, 10);
    for (const line of lines) {
        const trimmedLine = line.trim();
        // Simple heuristic: a name is usually short and doesn't look like a sentence.
        if (trimmedLine.length > 0 && trimmedLine.length < 50 && trimmedLine.split(' ').length < 5 && !trimmedLine.includes('@')) {
            return trimmedLine;
        }
    }
    return 'the candidate';
}

async function init() {
    await loadPrompts();
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

    sendBtn.addEventListener('click', handleUserInput);
    userInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') handleUserInput();
    });
    micBtn.addEventListener('click', () => {
        if (isRecognizing) {
            recognition.stop();
            return;
        }
        if (recognition) {
            recognition.start();
        }
    });
    window.addEventListener('resize', onWindowResize, false);

    // --- Speech Recognition Setup ---
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.lang = 'en-US';
        recognition.interimResults = false;

        recognition.onstart = () => {
            isRecognizing = true;
            micBtn.textContent = '...';
            micBtn.classList.add('recording');
            userInput.disabled = true;
            sendBtn.disabled = true;
        };

        recognition.onresult = async (event) => {
            const transcript = event.results[0][0].transcript;
            
                        const correctingMessage = addMessageToLog('<i>Correcting transcript...</i>', 'system');
            
            const correctedText = await correctTextWithAI(transcript);
            
                        addMessageToLog(correctedText, 'user');
            userInput.value = correctedText;
            handleUserInput(); // Submit the corrected text to the interview flow
            correctingMessage.remove(); // Remove the 'Correcting...' message


        };

        recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            addMessageToLog(`Speech recognition error: ${event.error}`, 'avatar');
        };

        recognition.onend = () => {
            isRecognizing = false;
            micBtn.textContent = '🎤';
            micBtn.classList.remove('recording');
            userInput.disabled = false;
            sendBtn.disabled = false;
        };
    } else {
        console.warn('Speech Recognition not supported in this browser.');
        micBtn.disabled = true;
        micBtn.title = 'Speech recognition is not supported in your browser.';
    }

    // New setup flow listeners
    jobPrepBtn.addEventListener('click', () => {
        initialChoice.classList.add('hidden');
        jobPrepForm.classList.remove('hidden');
    });
    resumePrepBtn.addEventListener('click', () => {
        initialChoice.classList.add('hidden');
        resumePrepForm.classList.remove('hidden');
    });
    resumeUploadJob.addEventListener('change', handleResumeUpload);
    resumeUploadGeneral.addEventListener('change', handleResumeUpload);

    startBtn.addEventListener('click', async () => {
        jobDescription = jobDescriptionInput.value;
        jobLink = jobLinkInput.value;
        githubLink = githubLinkInput.value;
        linkedinLink = linkedinLinkInput.value;

        setupContainer.classList.add('hidden');
        chatContainer.classList.add('visible');
        document.getElementById('video-container').classList.add('visible');

        startIntroduction();

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
            video.srcObject = stream;
        } catch (err) {
            console.error("Failed to initialize camera:", err);
            addMessageToLog("Could not start camera. Please check permissions.", "avatar");
        }
    }, { once: true });

    modelsLoadedPromise = loadModels(); // Start loading models as soon as the app starts
    loadAvatar();
    animate();
}

function addMessageToLog(message, sender) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', `${sender}-message`);
    messageElement.innerHTML = message; // Use innerHTML to allow for simple formatting
    chatLog.appendChild(messageElement);
    chatLog.scrollTop = chatLog.scrollHeight;
    return messageElement; // Return the element so it can be updated or removed
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
            // --- DIAGNOSTIC LOG --- 
            // This will print the exact names of the parts we can animate.
            if (head && head.morphTargetDictionary) {
                console.log("Available Morph Targets:", Object.keys(head.morphTargetDictionary));
            }
            mixer = new THREE.AnimationMixer(model);
            loadAnimations();
        }, 
        undefined, 
        (error) => {
            console.error('An error happened while loading the avatar:', error);
            addMessageToLog('Error: Could not load the avatar model.', 'avatar');
        }
    );
}

function loadAnimations() {
    const loader = new FBXLoader();
    const animationPromises = animationNames.map(name => {
        return new Promise((resolve, reject) => {
            loader.load(`./assets/animations/${name}.fbx`,
                (fbx) => {
                    const action = mixer.clipAction(fbx.animations[0]);

                    // The 'Seated Idle' and 'Having A Meeting' animations must loop.
                    if (name === 'Seated Idle' || name === 'Having A Meeting') {
                        action.setLoop(THREE.LoopRepeat);
                    } else {
                        // Other animations like talking or clapping should only play once.
                        action.setLoop(THREE.LoopOnce);
                        action.clampWhenFinished = true;
                    }

                    animationActions.set(name, action);
                    resolve();
                },
                undefined, // onProgress callback
                (error) => {
                    console.error(`Failed to load animation ${name}:`, error);
                    reject(error);
                }
            );
        });
    });

    Promise.all(animationPromises)
        .then(() => {
            console.log("All animations loaded successfully.");
            playAction('Seated Idle'); // Start with the looping idle animation.
        })
        .catch(error => {
            console.error("An error occurred while loading animations:", error);
            addMessageToLog("Error: Could not load all avatar animations. The avatar may not behave as expected.", "avatar");
        });
}

function playAction(name) {
    console.log(`[Animation] Playing action: ${name}`);
    const action = animationActions.get(name);
    if (!action) {
        console.warn(`[Animation] Action "${name}" not found.`);
        return;
    }

    if (activeAction === action) return;

    const previousAction = activeAction;
    activeAction = action;

    if (previousAction) {
        console.log(`[Animation] Fading out previous action.`);
        previousAction.fadeOut(0.3);
    }

    action.reset().setEffectiveWeight(1).fadeIn(0.3).play();
}

function returnToIdle() {
    console.log("[State] Returning to idle.");
    playAction('Seated Idle');
}

// A mapping of preferred voice names for better quality.
const PREFERRED_VOICES = [
    'Google US English', // High-quality voice on Chrome
    'Microsoft Zira - English (United States)', // High-quality voice on Edge
    'Samantha', // Default on macOS
    'Alex' // Another high-quality voice
];

// Utility function to get voices, handling the async nature of the API.
function getVoices() {
    return new Promise(resolve => {
        let voices = speechSynthesis.getVoices();
        if (voices.length) {
            resolve(voices);
            return;
        }
        speechSynthesis.onvoiceschanged = () => {
            voices = speechSynthesis.getVoices();
            resolve(voices);
        };
    });
}

function animateVisemes() {
    if (!head || !head.morphTargetDictionary) return;

    const jawOpenIndex = head.morphTargetDictionary['jawOpen'];
    if (jawOpenIndex === undefined) return; // Can't animate if no jawOpen

    const now = Date.now();
    // Create a gentle, oscillating motion for the jaw
    const jawValue = (Math.sin(now * 0.015) + 1) / 2 * 0.6; // Oscillates between 0 and 0.6
    head.morphTargetInfluences[jawOpenIndex] = jawValue;

    // Add subtle funneling for more realism
    const mouthFunnelIndex = head.morphTargetDictionary['mouthFunnel'];
    if (mouthFunnelIndex !== undefined) {
        head.morphTargetInfluences[mouthFunnelIndex] = (Math.cos(now * 0.01) + 1) / 4; // Oscillates between 0 and 0.5
    }

    visemeAnimationId = requestAnimationFrame(animateVisemes);
}

function stopVisemeAnimation() {
    if (visemeAnimationId) {
        cancelAnimationFrame(visemeAnimationId);
        visemeAnimationId = null;
    }
    if (head && head.morphTargetInfluences) {
        // Reset all mouth-related influences to 0 to avoid a stuck-open mouth
        for (const key in head.morphTargetDictionary) {
            if (key.startsWith('mouth') || key.startsWith('jaw')) {
                head.morphTargetInfluences[head.morphTargetDictionary[key]] = 0;
            }
        }
    }
}

async function speak(text) {
    if (isSpeaking) {
        console.warn("Speak called while another utterance is active. Ignoring new request.");
        return Promise.resolve();
    }
    isSpeaking = true;
    speechSynthesis.cancel(); // Clean slate before starting.

    return new Promise(async (resolve, reject) => {
        if (!text) {
            isSpeaking = false;
            resolve();
            return;
        }

        addMessageToLog(text, 'avatar');
        playAction('Sitting Talking');

        const chunks = text.match(/[^.!?\n]+[.!?\n]?/g) || [];
        if (chunks.length === 0) {
            playAction('Seated Idle');
            isSpeaking = false;
            resolve();
            return;
        }

        const voices = await getVoices();
        const preferredVoice = voices.find(v => v.name.includes('Google') && v.name.includes('English')) || voices.find(v => v.name.includes('English'));
        let currentChunk = 0;

        function speakNextChunk() {
            if (currentChunk >= chunks.length) {
                stopVisemeAnimation();
                playAction('Seated Idle');
                isSpeaking = false;
                resolve();
                return;
            }

            const chunk = chunks[currentChunk].trim();
            if (!chunk) {
                currentChunk++;
                speakNextChunk();
                return;
            }

            const utterance = new SpeechSynthesisUtterance(chunk);
            if (preferredVoice) {
                utterance.voice = preferredVoice;
            }

            let timeoutId;
            let ended = false;

            const handleEnd = (error) => {
                if (ended) return;
                ended = true;
                clearTimeout(timeoutId);

                if (error) {
                    stopVisemeAnimation();
                    console.error('Speech synthesis error or timeout on chunk:', chunk, error);
                    playAction('Seated Idle');
                    isSpeaking = false;
                    reject(error);
                } else {
                    currentChunk++;
                    setTimeout(speakNextChunk, 0);
                }
            };

            const estimatedDuration = Math.max(8000, chunk.length * 250);
            timeoutId = setTimeout(() => handleEnd(new Error("Speech synthesis for chunk timed out")), estimatedDuration);

            utterance.onend = () => handleEnd(null);
            utterance.onerror = (event) => handleEnd(event.error);

            try {
                if (!visemeAnimationId) {
                    animateVisemes();
                }
                speechSynthesis.speak(utterance);
            } catch (e) {
                handleEnd(e);
            }
        }

        speakNextChunk();
    });
}

// --- Interview Flow & AI Interaction ---
async function startIntroduction() {
    if (interviewState.isFinished) return;

    userInput.disabled = true;
    sendBtn.disabled = true;
    micBtn.disabled = true;

    try {
        const candidateName = interviewState.candidateName || 'the candidate';
        let systemPrompt;

        if (jobDescription) {
            systemPrompt = promptTemplates.interview.initial_cv_and_job
                .replace('{candidateName}', candidateName)
                .replace('{jobDescription}', jobDescription)
                .replace('{resumeText}', resumeText);
        } else {
            systemPrompt = promptTemplates.interview.initial_cv_only
                .replace('{candidateName}', candidateName)
                .replace('{resumeText}', resumeText);
        }

        const thinkingMessage = addMessageToLog('<i>zerochomage is thinking...</i>', 'system');
        const firstQuestion = await getAIResponse([], systemPrompt);
        thinkingMessage.remove();

        if (firstQuestion) {
            await speak(firstQuestion);
            interviewState.conversationHistory.push({ role: 'assistant', content: firstQuestion });
            interviewState.questionsAsked++;
        } else {
            await speak("I'm having a little trouble getting started. Please try reloading the page.");
        }
    } catch (error) {
        console.error("Error during introduction:", error);
        await speak("It seems I've run into a problem. Let's try to continue.").catch(e => console.error("Fallback speech failed:", e));
    } finally {
        userInput.disabled = false;
        sendBtn.disabled = false;
        micBtn.disabled = false;
        userInput.focus();
    }
}

async function askNextQuestion() {
    if (interviewState.questionsAsked >= interviewState.totalQuestions) {
        interviewState.isFinished = true;
        await getFinalEvaluation();
        return;
    }

    const historyString = interviewState.conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n');
    const systemPrompt = promptTemplates.interview.next_question
        .replace('{questionNumber}', interviewState.questionsAsked + 1)
        .replace('{totalQuestions}', interviewState.totalQuestions)
        .replace('{resumeText}', resumeText || 'No resume provided.')
        .replace('{conversationHistory}', historyString);

    const thinkingMessage = addMessageToLog('<i>zerochomage is thinking...</i>', 'system');
    const nextQuestion = await getAIResponse(interviewState.conversationHistory, systemPrompt);
    thinkingMessage.remove();

    if (nextQuestion) {
        await speak(nextQuestion);
        interviewState.conversationHistory.push({ role: 'assistant', content: nextQuestion });
        interviewState.questionsAsked++;
    } else {
        await speak("I'm not sure what to ask next. Could you tell me more about your last project?");
    }
}

async function getFinalEvaluation() {
    addMessageToLog('<i>Generating final evaluation...</i>', 'system');
    const historyString = interviewState.conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n');
    const systemPrompt = promptTemplates.interview.final_evaluation
        .replace('{totalQuestions}', interviewState.totalQuestions)
        .replace('{candidateName}', interviewState.candidateName || 'the candidate')
        .replace('{conversationHistory}', historyString);

    const evaluation = await getAIResponse(interviewState.conversationHistory, systemPrompt);
    if (evaluation) {
        await speak(evaluation);
    }

    userInput.placeholder = 'Interview finished. Thank you.';
    userInput.disabled = true;
    sendBtn.disabled = true;
    micBtn.disabled = true;
}

async function correctTextWithAI(rawText) {
    const systemPrompt = promptTemplates.text_correction;
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Raw text: \"${rawText}\"` }
    ];

    try {
        const correctedText = await getAIResponse(messages);
        return correctedText || rawText;
    } catch (error) {
        console.error('Failed to correct text with AI:', error);
        return rawText; // Fallback to the raw text
    }
}

async function getAIResponse(messages, systemPromptContent) {
    const allMessages = [];
    if (systemPromptContent) {
        allMessages.push({ role: 'system', content: systemPromptContent });
    }
    allMessages.push(...messages);

    if (allMessages.length > 20) {
        allMessages.splice(1, allMessages.length - 20);
    }

    const messageElement = addMessageToLog('...', 'avatar');

    try {
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'http://localhost/',
                'X-Title': 'Live Interview'
            },
            body: JSON.stringify({
                model: "openai/gpt-3.5-turbo",
                messages: allMessages,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            const errorMessage = `Sorry, I encountered an error: ${response.statusText}. Please try again.`;
            console.error(`API Error: ${response.statusText}`, errorText);
            messageElement.textContent = errorMessage;
            return null;
        }

        const data = await response.json();
        if (data.choices && data.choices.length > 0 && data.choices[0].message) {
            const aiMessage = data.choices[0].message.content;
            messageElement.innerHTML = aiMessage.replace(/\n/g, '<br>');
            return aiMessage;
        } else {
            const errorMessage = "I received an unusual response from the AI. Please try again.";
            console.error("Invalid response structure from AI API:", data);
            messageElement.textContent = errorMessage;
            return null;
        }
    } catch (error) {
        const errorMessage = "Sorry, I'm having trouble connecting to the AI service. Please check your network connection.";
        console.error("Network or other error in getAIResponse:", error);
        messageElement.textContent = errorMessage;
        return null;
    }
}

async function callOpenRouter(messages, temperature = 0.7) {
    if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY.includes("REPLACE-THIS")) {
        throw new Error('API key is not set.');
    }

    const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'http://localhost:8000', // Replace with your actual domain in production
            'X-Title': 'AI Interviewer' // Optional: Replace with your project title
        },
        body: JSON.stringify({
            model: 'google/gemini-flash-1.5',
            messages: messages,
            temperature: temperature,
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData?.error?.message || `API request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
}

// --- Video & Face Analysis ---
function loadModels() {
    try {
        if (typeof faceapi === 'undefined') {
            throw new Error("face-api.js script not loaded");
        }
        // Corrected the path to point to the local assets directory.
        const modelPath = 'assets/models'; 
        return Promise.all([
            faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath),
            faceapi.nets.tinyFaceDetector.loadFromUri(modelPath),
            faceapi.nets.faceLandmark68Net.loadFromUri(modelPath),
            faceapi.nets.faceRecognitionNet.loadFromUri(modelPath),
            faceapi.nets.faceExpressionNet.loadFromUri(modelPath),
            faceapi.nets.ageGenderNet.loadFromUri(modelPath)
        ]).catch(err => {
            console.error("Could not load face detection models.", err);
            addMessageToLog("Error: AI models for face analysis failed to load. Video analysis will be disabled.", "avatar");
            return Promise.resolve(); // Gracefully continue without face detection.
        });
    } catch (err) {
        console.error("Fatal error during faceapi model loading setup:", err);
        addMessageToLog("Error: Could not initialize face analysis. Video analysis will be disabled.", "avatar");
        return Promise.resolve(); // Return a resolved promise to prevent the entire app from crashing.
    }
}

video.addEventListener('play', async () => {
    try {
        await modelsLoadedPromise;
        if (faceDetectionIntervalId) clearInterval(faceDetectionIntervalId);
        faceDetectionIntervalId = setInterval(async () => {
            const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceExpressions();
            handleDetection(detection);
        }, FACE_DETECTION_INTERVAL);
    } catch (err) {
        console.error("Face detection cannot start because models failed to load.", err);
    }
});

function handleDetection(detection) {
    // Simplified face detection: only check if the user is visible or not.
    if (detection) {
        // If the user is visible, reset the missing timer and the state.
        userMissingSince = null;
        setState('neutral'); // This won't fire constantly due to the state lock.
    } else {
        // If the user is not visible, start a timer.
        if (!userMissingSince) {
            userMissingSince = Date.now();
        } else if (Date.now() - userMissingSince > USER_MISSING_DURATION) {
            // If the user has been missing for too long, send a message.
            setState('user_missing', "I can't seem to see you. Are you still there?");
        }
    }
}

function getHeadRotation(landmarks) {
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    const nose = landmarks.getNose();
    const eyeCenter = { x: (leftEye[0].x + rightEye[3].x) / 2, y: (leftEye[0].y + rightEye[3].y) / 2 };
    const rotationY = (nose[3].x - eyeCenter.x) / (rightEye[3].x - leftEye[0].x);
    const rotationX = (nose[3].y - eyeCenter.y) / 50; // Heuristic
    return { y: rotationY, x: rotationX };
}

function getEAR(landmarks) {
    return (calculateEARForEye(landmarks.getLeftEye()) + calculateEARForEye(landmarks.getRightEye())) / 2.0;
}

function calculateEARForEye(eye) {
    const a = Math.hypot(eye[1].x - eye[5].x, eye[1].y - eye[5].y);
    const b = Math.hypot(eye[2].x - eye[4].x, eye[2].y - eye[4].y);
    const c = Math.hypot(eye[0].x - eye[3].x, eye[0].y - eye[3].y);
    return (a + b) / (2.0 * c);
}

function setState(newState, message) {
    if (stateLock || currentState === newState) return;
    currentState = newState;
    if (message) {
        stateLock = true;
        // The speak function will add the message to the log, so we don't do it here.
        // Using a neutral 'Sitting Talking' animation instead of 'Disapproval'.
        speak(message, 'Sitting Talking');
        // Reduced cooldown to make the feedback feel more responsive.
        setTimeout(() => { stateLock = false; }, 5000); // 5s cooldown
    }
}



function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);
    renderer.render(scene, camera);
}

window.addEventListener('DOMContentLoaded', () => {
    // --- Start the application ---
    if (OPENROUTER_API_KEY.includes("REPLACE-THIS")) {
        const errorMsg = "API Key is not set. Please open main.js, replace the placeholder key with your real OpenRouter API key, and then hard-refresh the page (Ctrl+Shift+R or Cmd+Shift+R).";
        alert(errorMsg);
        document.getElementById('setup-container').innerHTML = `<h2>Configuration Needed</h2><p>${errorMsg}</p>`;
        document.getElementById('chat-container').style.display = 'none';
    } else {
        init(); // Proceed with initialization
    }
});
