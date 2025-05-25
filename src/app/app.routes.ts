import { Routes } from '@angular/router';
import { EmotionComponent } from './emotion/emotion.component';

export const routes: Routes = [
  { path: '**', component: EmotionComponent },
  { path: '', component: EmotionComponent }
];
