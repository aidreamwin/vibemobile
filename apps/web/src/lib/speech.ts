/**
 * Voice input via the Web Speech API.
 *
 * Availability is genuinely uneven: Chrome on Android works well, iOS Safari
 * has partial support, and Firefox has none. Everything here degrades to
 * "unsupported" so the UI can hide the button rather than fail on tap.
 */

interface SpeechRecognitionResultLike {
  0: { transcript: string }
  isFinal: boolean
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [index: number]: SpeechRecognitionResultLike }
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const speechSupported = (): boolean => getCtor() !== null

export interface Dictation {
  stop(): void
}

/**
 * Start dictating. `onText` fires with the accumulated transcript including
 * interim results; the caller decides whether to commit it.
 */
export function startDictation(
  onText: (text: string, isFinal: boolean) => void,
  onError: (message: string) => void,
  lang = 'zh-CN',
): Dictation {
  const Ctor = getCtor()
  if (!Ctor) {
    onError('当前浏览器不支持语音输入')
    return { stop() {} }
  }

  const recognition = new Ctor()
  recognition.lang = lang
  recognition.continuous = true
  recognition.interimResults = true

  let finalText = ''

  recognition.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      if (!result) continue
      if (result.isFinal) finalText += result[0].transcript
      else interim += result[0].transcript
    }
    onText(finalText + interim, interim === '')
  }

  recognition.onerror = (event) => {
    const messages: Record<string, string> = {
      'not-allowed': '麦克风权限被拒绝',
      'service-not-allowed': '浏览器不允许使用语音服务',
      'no-speech': '没有听到语音',
      network: '语音服务网络错误',
    }
    onError(messages[event.error] ?? `语音识别失败：${event.error}`)
  }

  try {
    recognition.start()
  } catch (err) {
    onError((err as Error).message)
  }

  return {
    stop() {
      try {
        recognition.stop()
      } catch {
        /* already stopped */
      }
    },
  }
}
