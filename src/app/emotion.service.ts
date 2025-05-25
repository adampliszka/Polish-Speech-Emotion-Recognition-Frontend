import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class EmotionService {
  private baseUrl = 'http://127.0.0.1:5000';

  constructor(private http: HttpClient) {}

  loadModel(modelName: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/load_model`, { model_name: modelName });
  }

  predict(audioData: Float32Array, sampleRate: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/predict`, {
      audio_data: Array.from(audioData),
      sample_rate: sampleRate
    });
  }
}
