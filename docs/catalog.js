export const categories = [
  ['text', 'Modele tekstowe'],
  ['audio', 'Live i audio'],
  ['tts', 'Synteza mowy'],
  ['other', 'Agenty i pozostałe']
];

// Wartości referencyjne przekazane przez użytkownika. null oznacza Unlimited.
export const models = [
  ['text', 'Gemini 2.5 Flash', 'gemini-2.5-flash', 5, 250000, 20],
  ['text', 'Gemini 2.5 Flash Lite', 'gemini-2.5-flash-lite', 10, 250000, 20],
  ['text', 'Gemini 3 Flash', 'gemini-3-flash-preview', 5, 250000, 20],
  ['text', 'Gemini 3.1 Flash Lite', 'gemini-3.1-flash-lite', 15, 250000, 500],
  ['text', 'Gemini 3.5 Flash Lite', 'gemini-3.5-flash-lite', 15, 250000, 500],
  ['text', 'Gemini 3.6 Flash', 'gemini-3.6-flash', 5, 250000, 20],
  ['text', 'Gemini 3.8 Flash', 'gemini-3.8-flash', 5, 250000, 20],

  ['audio', 'Gemini 2.5 Flash Native Audio Dialog', 'gemini-2.5-flash-native-audio-preview-12-2025', null, 1000000, null, 'Live API'],
  ['audio', 'Gemini 3 Flash Live', null, null, 65000, null, 'Live API'],
  ['audio', 'Gemini 3.5 Live Translate', 'gemini-3.5-live-translate-preview', null, 20000, null, 'Live API'],
  ['audio', 'Gemini 3.5 Transcribe Live', 'gemini-3.5-transcribe-live', null, 20000, null, 'Live API'],
  ['audio', 'Gemini 3.5 Transcribe', 'gemini-3.5-transcribe', 3, 10000, 25],
  ['audio', 'Gemini 3.8 Live', 'gemini-3.8-live', null, 65000, null, 'Live API'],
  ['audio', 'Gemini 3.8 Live Extended Thinking', 'gemini-3.8-live-extended-thinking', null, 65000, null, 'Live API'],

  ['tts', 'Gemini 2.5 Flash TTS', 'gemini-2.5-flash-preview-tts', 3, 10000, 10],
  ['tts', 'Gemini 3.1 Flash TTS', 'gemini-3.1-flash-tts-preview', 3, 10000, 10],
  ['tts', 'Gemini 3.8 Flash Lite TTS', 'gemini-3.8-flash-lite-tts', 3, 10000, 10, 'Interactions API'],
  ['tts', 'Gemini 3.8 Flash TTS', 'gemini-3.8-flash-tts', 3, 10000, 10, 'Interactions API'],

  ['other', 'ChartsAntigravity', null, 60, 100000, 100, 'Agenty'],
  ['other', 'Gemini Embedding 1', 'gemini-embedding-001', 100, 30000, 1000, 'Embeddings API'],
  ['other', 'Gemini Embedding 2', 'gemini-embedding-2', 100, 30000, 1000, 'Embeddings API'],
  ['other', 'Gemini Robotics ER 2 Preview', 'gemini-robotics-er-2-preview', 5, 250000, 20],
  ['other', 'Gemma 4 26B', 'gemma-4-26b-a4b-it', 30, 16000, 14400],
  ['other', 'Gemma 4 31B', 'gemma-4-31b-it', 30, 16000, 14400]
].map(([category, name, id, rpm, tpm, rpd, externalApi]) => ({
  category, name, id, limits: { rpm, tpm, rpd }, externalApi
}));
