import axios from 'axios';
import { CAPMONSTER_API_KEY, CAPMONSTER_PROXY } from '../config.js';
import { logger } from './logger.js';

const capmonster = axios.create({
  baseURL: 'https://api.capmonster.cloud',
  headers: { 'Content-Type': 'application/json' },
  timeout: 20_000,
});

function proxyPayload(): Record<string, unknown> | undefined {
  if (!CAPMONSTER_PROXY) return undefined;
  try {
    const url = new URL(CAPMONSTER_PROXY);
    return {
      isEnabled: true,
      type: 'http',
      address: url.hostname,
      port: Number(url.port || 80),
      login: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
    };
  } catch {
    logger.warn('CAPMONSTER_PROXY invalid URL, ignoring');
    return undefined;
  }
}

async function createTask(image64: string): Promise<string | null> {
  if (!CAPMONSTER_API_KEY) return null;

  const task: Record<string, unknown> = {
    type: 'ImageToTextTask',
    // Модуль CapMonster под капчу FunTime
    capMonsterModule: 'funtime-9bc0c7',
    body: image64,
    numeric: 1,
    math: false,
  };

  const body: Record<string, unknown> = {
    clientKey: CAPMONSTER_API_KEY,
    task,
  };
  const proxy = proxyPayload();
  if (proxy) body.proxy = proxy;

  const { data } = await capmonster.post('/createTask', body);
  if (data.errorId !== 0 || !data.taskId) {
    logger.error('CapMonster createTask error', data);
    return null;
  }
  return String(data.taskId);
}

async function getTaskResult(taskId: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const { data } = await capmonster.post('/getTaskResult', {
      clientKey: CAPMONSTER_API_KEY,
      taskId,
    });
    if (data.status === 'ready') {
      return data.solution?.text ? String(data.solution.text) : undefined;
    }
    if (data.status === 'processing') {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    logger.error('CapMonster getTaskResult unexpected', data);
    return undefined;
  }
  logger.warn('CapMonster timeout waiting for result');
  return undefined;
}

/** Решить капчу FunTime (base64 PNG без data: префикса). */
export async function solveFuntimeCaptcha(image64: string): Promise<string | undefined> {
  if (!CAPMONSTER_API_KEY) {
    logger.warn('CAPMONSTER_API_KEY не задан — капчу не решаю');
    return undefined;
  }
  try {
    const taskId = await createTask(image64);
    if (!taskId) return undefined;
    return getTaskResult(taskId);
  } catch (error) {
    logger.error('solveFuntimeCaptcha failed', error);
    return undefined;
  }
}

export function captchaEnabled(): boolean {
  return Boolean(CAPMONSTER_API_KEY?.trim());
}
