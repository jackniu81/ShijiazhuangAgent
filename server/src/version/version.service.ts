import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface AppVersion {
  name: string;
  version: string;
  node: string;
  timestamp: string;
}

@Injectable()
export class VersionService {
  private readonly pkg: { name: string; version: string };

  constructor() {
    this.pkg = this.readPackage();
  }

  /** Resolves package.json robustly across dev (tsx) and compiled (dist) layouts. */
  private readPackage(): { name: string; version: string } {
    const candidates = [
      join(__dirname, '..', 'package.json'), // dist/  -> server/
      join(__dirname, '..', '..', 'package.json'), // dist/version -> server/
      join(__dirname, 'package.json'), // src/version fallback
      join(process.cwd(), 'package.json'),
      join(process.cwd(), 'server', 'package.json'),
    ];
    for (const path of candidates) {
      if (existsSync(path)) {
        try {
          const json = JSON.parse(readFileSync(path, 'utf-8'));
          if (json.name && json.version) {
            return { name: json.name, version: json.version };
          }
        } catch {
          // ignore malformed and try the next candidate
        }
      }
    }
    return { name: 'server', version: '0.0.0-unknown' };
  }

  getVersion(): AppVersion {
    return {
      name: this.pkg.name,
      version: this.pkg.version,
      node: process.version,
      timestamp: new Date().toISOString(),
    };
  }
}
