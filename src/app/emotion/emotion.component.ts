import { Component } from '@angular/core';
import { EmotionService } from '../emotion.service';
import { FormsModule } from '@angular/forms';
import {AsyncPipe, DecimalPipe, NgForOf, NgIf, NgStyle} from '@angular/common';
import { BehaviorSubject, EMPTY, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';

@Component({
  selector: 'app-emotion',
  templateUrl: './emotion.component.html',
  imports: [
    FormsModule,
    NgIf,
    AsyncPipe,
    NgStyle,
    NgForOf,
    DecimalPipe
  ],
  styleUrl: './emotion.component.css'
})
export class EmotionComponent {
  modelName = 'XGBoost';
  emotions = ["anger", "fear", "happiness", "neutral", "sadness", "surprised"];

  private statusMessageSubject = new BehaviorSubject<string>('Select a model and load it, then either record or upload audio to predict emotion.');
  private probabilitiesSubject = new BehaviorSubject<number[]>([0, 0, 0, 0, 0, 0]);
  private modelLoadedSubject = new BehaviorSubject<boolean>(false);

  statusMessage$ = this.statusMessageSubject.asObservable();
  probabilities$ = this.probabilitiesSubject.asObservable();
  modelLoaded$ = this.modelLoadedSubject.asObservable();

  private loadModelSubject = new BehaviorSubject<string | null>(null);
  private predictSubject = new BehaviorSubject<Float32Array | null>(null);
  recording: boolean = false;
  isPredicting: boolean = false;
  continuousAnalysis: boolean = false;
  audioContext: AudioContext | null = null;
  mediaRecorder: MediaRecorder | null = null;
  audioChunks: Blob[] = [];

  private recordingTimeoutId: any = null;

  private rollingBuffer: Float32Array = new Float32Array(16000 * 10); // 10 seconds at 16kHz
  private bufferIndex: number = 0;

  constructor(private emotionService: EmotionService) {
    this.loadModelSubject.pipe(
      switchMap((modelName) => {
        if (!modelName) return EMPTY;
        return this.emotionService.loadModel(modelName).pipe(
          tap((response) => {
            this.statusMessageSubject.next(response.message);
            this.modelLoadedSubject.next(true);
          }),
          catchError((error) => {
            this.statusMessageSubject.next(`Error: ${error.error?.message || JSON.stringify(error)}`);
            return of(null);
          })
        );
      })
    ).subscribe();

    this.predictSubject.pipe(
      switchMap((audioData) => {
        if (!audioData) return EMPTY;

        const sanitizedAudioData = audioData.map((value) => isNaN(value) ? 0 : value);
        return this.emotionService.predict(sanitizedAudioData, 16000).pipe(
          tap((response) => {
            this.probabilitiesSubject.next(response.probabilities);
            this.updateChart(response.probabilities);
            this.statusMessageSubject.next(`Predicted Emotion: ${response.predicted_emotion}`);
          }),
          catchError((error) => {
            this.statusMessageSubject.next(`Error: ${error.error?.message || JSON.stringify(error)}`);
            return of(null);
          }),
          tap(() => {
            this.isPredicting = false;
          })
        );
      })
    ).subscribe();
  }

  loadModel() {
    this.loadModelSubject.next(this.modelName);
  }

  async uploadAudio() {
    if (this.isPredicting) {
      this.statusMessageSubject.next('Please wait for the current prediction to complete.');
      return;
    }
    if (this.recording) {
      this.statusMessageSubject.next('Please stop the current recording before uploading audio.');
      return;
    }
    if (this.continuousAnalysis) {
      this.statusMessageSubject.next('Please stop continuous analysis before uploading audio.');
      return;
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (file) {
        try {
          this.statusMessageSubject.next('Processing audio file...');

          // Properly decode audio file using Web Audio API
          const arrayBuffer = await file.arrayBuffer();
          const audioContext = new AudioContext();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          // Get audio data from the first channel
          const audioData = audioBuffer.getChannelData(0);

          // Send original audio data and sample rate to backend
          // Let the backend handle proper resampling using torchaudio
          this.isPredicting = true;
          this.statusMessageSubject.next('Predicting...');
          
          // Send original data with original sample rate directly to service
          const sanitizedAudioData = new Float32Array(audioData.length);
          for (let i = 0; i < audioData.length; i++) {
            sanitizedAudioData[i] = isNaN(audioData[i]) ? 0 : audioData[i];
          }
          this.emotionService.predict(sanitizedAudioData, audioBuffer.sampleRate).pipe(
            tap((response) => {
              this.probabilitiesSubject.next(response.probabilities);
              this.updateChart(response.probabilities);
              this.statusMessageSubject.next(`Predicted Emotion: ${response.predicted_emotion}`);
            }),
            catchError((error) => {
              this.statusMessageSubject.next(`Error: ${error.error?.message || JSON.stringify(error)}`);
              return of(null);
            }),
            tap(() => {
              this.isPredicting = false;
            })
          ).subscribe();

          // Clean up
          await audioContext.close();

        } catch (error) {
          this.statusMessageSubject.next(`Error processing audio file: ${error}`);
          console.error('Audio processing error:', error);
        }
      }
    };
    fileInput.click();
  }

  startRecording() {
    if (this.isPredicting) {
      this.statusMessageSubject.next('Please wait for the current prediction to complete.');
      return;
    }
    if (this.continuousAnalysis) {
      this.statusMessageSubject.next('Please stop continuous analysis before starting a new recording.');
      return;
    }

    this.recording = true;
    this.audioContext = new AudioContext();
    const button = document.getElementById('recordButton') as HTMLElement;

    button.classList.add('recording-progress');

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];
      this.updateWaveformDuringRecording();

      this.mediaRecorder.ondataavailable = (event) => {
        this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = async () => {
        try {
          this.statusMessageSubject.next('Processing recorded audio...');

          // Create audio blob and properly decode it
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/wav' });
          const arrayBuffer = await audioBlob.arrayBuffer();

          // Use Web Audio API to properly decode the recorded audio
          const audioContext = new AudioContext();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          // Get audio data from the first channel
          const audioData = audioBuffer.getChannelData(0);

          // Resample to 16kHz if needed
          const targetSampleRate = 16000;
          let processedAudioData: Float32Array;

          if (audioBuffer.sampleRate !== targetSampleRate) {
            processedAudioData = this.resampleAudio(audioData, audioBuffer.sampleRate, targetSampleRate);
          } else {
            processedAudioData = audioData;
          }

          this.isPredicting = true;
          this.statusMessageSubject.next('Predicting...');
          this.predictSubject.next(processedAudioData);
          this.audioChunks = [];

          // Clean up
          await audioContext.close();

        } catch (error) {
          this.statusMessageSubject.next(`Error processing recorded audio: ${error}`);
          console.error('Recording processing error:', error);
        }

        button.classList.remove('recording-progress');
      };

      this.mediaRecorder.start();

      this.recordingTimeoutId = setTimeout(() => {
        if (this.recording) {
          this.stopRecording();
        }
      }, 20000);
    });
  }

  stopRecording() {
    if (!this.recording) return;
    this.recording = false;

    if (this.recordingTimeoutId) {
      clearTimeout(this.recordingTimeoutId);
      this.recordingTimeoutId = null;
    }

    this.mediaRecorder?.stop();
    this.mediaRecorder = null;
    const button = document.getElementById('recordButton') as HTMLElement;
    button.classList.remove('recording-progress');
    button.classList.add('snap-back');
    setTimeout(() => button.classList.remove('snap-back'), 0);
  }

  async startContinuousAnalysis() {
    if (this.isPredicting) {
      this.statusMessageSubject.next('Please wait for the current prediction to complete.');
      return;
    }
    if (this.recording) {
      this.statusMessageSubject.next('Please stop the current recording before starting continuous analysis.');
      return;
    }
    this.continuousAnalysis = true;
    this.audioContext = new AudioContext();
    const inputSampleRate = this.audioContext.sampleRate;
    const targetSampleRate = 16000;
    const chunkDuration = 1;
    const chunkSize = targetSampleRate * chunkDuration;
    let audioBuffer: Float32Array = new Float32Array();

    await this.audioContext.audioWorklet.addModule('assets/audio-processor.js');
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const source = this.audioContext!.createMediaStreamSource(stream);
      const audioWorkletNode = new AudioWorkletNode(this.audioContext!, 'audio-processor');

      audioWorkletNode.port.onmessage = (event) => {
        const inputData = event.data;

        const resampledData = this.resampleAudio(inputData, inputSampleRate, targetSampleRate);

        const newBuffer = new Float32Array(audioBuffer.length + resampledData.length);
        newBuffer.set(audioBuffer);
        newBuffer.set(resampledData, audioBuffer.length);
        audioBuffer = newBuffer;

        if (audioBuffer.length >= chunkSize) {
          const chunk = audioBuffer.slice(0, chunkSize);
          this.predictSubject.next(chunk);
          audioBuffer = audioBuffer.slice(chunkSize);
        }
      };

      source.connect(audioWorkletNode);

      const analyser = this.audioContext!.createAnalyser();
      source.connect(analyser);

      const bufferLength = analyser.fftSize;
      const dataArray = new Float32Array(bufferLength);

      const draw = () => {
        if (!this.continuousAnalysis) return;

        analyser.getFloatTimeDomainData(dataArray);
        this.drawWaveform(dataArray);

        requestAnimationFrame(draw);
      };

      draw();
    });
  }

  stopContinuousAnalysis() {
    this.continuousAnalysis = false;
    this.audioContext?.close();
  }

  private resampleAudio(inputData: Float32Array, inputRate: number, outputRate: number): Float32Array {
    if (inputRate === outputRate) return inputData;

    const ratio = inputRate / outputRate;
    const newLength = Math.floor(inputData.length / ratio);
    const resampledData = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      resampledData[i] = inputData[Math.floor(i * ratio)];
    }

    return resampledData;
  }

  updateChart(probabilities: number[]) {
    this.probabilitiesSubject.next(probabilities);
  }

  private drawWaveform(audioData: Float32Array) {
    const canvas = document.getElementById('waveform') as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);

    const width = canvas.width;
    const height = canvas.height;
    const middle = height / 2;

    const availableSpace = this.rollingBuffer.length - this.bufferIndex;
    if (audioData.length <= availableSpace) {
      this.rollingBuffer.set(audioData, this.bufferIndex);
      this.bufferIndex += audioData.length;
    } else {
      this.rollingBuffer.set(audioData.subarray(0, availableSpace), this.bufferIndex);
      this.rollingBuffer.set(audioData.subarray(availableSpace), 0);
      this.bufferIndex = audioData.length - availableSpace;
    }

    context.beginPath();
    context.moveTo(0, middle);

    const step = Math.ceil(this.rollingBuffer.length / width);
    for (let i = 0; i < width; i++) {
      const value = this.rollingBuffer[(this.bufferIndex + i * step) % this.rollingBuffer.length] || 0;

      const logValue = Math.sign(value) * Math.log1p(Math.abs(value));
      const y = middle + logValue * middle;

      context.lineTo(i, y);
    }

    context.strokeStyle = '#007bff';
    context.lineWidth = 2;
    context.stroke();
  }

  private updateWaveformDuringRecording() {
    if (!this.audioContext || !this.mediaRecorder) return;

    const analyser = this.audioContext.createAnalyser();
    const source = this.audioContext.createMediaStreamSource(this.mediaRecorder.stream);
    source.connect(analyser);

    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);

    const draw = () => {
      if (!this.recording) return;

      analyser.getFloatTimeDomainData(dataArray);
      this.drawWaveform(dataArray);

      requestAnimationFrame(draw);
    };

    draw();
  }
}
