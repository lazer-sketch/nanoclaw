/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 */
import { execSync } from 'child_process';
import path from 'path';

import { logger } from '../src/logger.js';
import { commandExists } from './platform.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { runtime: string } {
  let runtime = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      runtime = args[i + 1];
      i++;
    }
  }
  return { runtime };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = 'nanoclaw-agent:latest';
  const logFile = path.join(projectRoot, 'logs', 'setup.log');

  if (!runtime) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: 'unknown',
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'missing_runtime_flag',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  // Validate runtime availability
  if (runtime === 'apple-container' && !commandExists('container')) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  if (runtime === 'docker') {
    if (!commandExists('docker')) {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
    try {
      execSync('docker info', { stdio: 'ignore' });
    } catch {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  if (!['apple-container', 'docker'].includes(runtime)) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'unknown_runtime',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const buildCmd =
    runtime === 'apple-container' ? 'container build' : 'docker build';
  const runCmd = runtime === 'apple-container' ? 'container' : 'docker';

  // Build
  let buildOk = false;
  logger.info({ runtime }, 'Building container');
  try {
    execSync(`${buildCmd} -t ${image} .`, {
      cwd: path.join(projectRoot, 'container'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('Container build succeeded');
  } catch (err) {
    logger.error({ err }, 'Container build failed');
  }

  // Test
  let testOk = false;
  if (buildOk) {
    logger.info('Testing container');
    try {
      const output = execSync(
        `echo '{}' | ${runCmd} run -i --rm --entrypoint /bin/echo ${image} "Container OK"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      testOk = output.includes('Container OK');
      logger.info({ testOk }, 'Container test result');
    } catch {
      logger.error('Container test failed');
    }
  }

  // Test container→host gateway connectivity (Linux + Docker only)
  let gatewayReachable: boolean | undefined;
  if (buildOk && testOk && runtime === 'docker') {
    try {
      const result = execSync(
        `docker run --rm --add-host=host.docker.internal:host-gateway ${image} sh -c "curl -sf -m 5 http://host.docker.internal:10254/api/health || wget -qO- --timeout=5 http://host.docker.internal:10254/api/health" 2>/dev/null`,
        { encoding: 'utf-8', timeout: 15000 },
      );
      gatewayReachable = result.includes('"ok"');
    } catch {
      gatewayReachable = false;
      logger.warn(
        'Container cannot reach OneCLI gateway on host — if UFW is active, run: sudo ufw allow in on docker0 to any port 10254 && sudo ufw allow in on docker0 to any port 10255',
      );
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    ...(gatewayReachable !== undefined ? { GATEWAY_REACHABLE: gatewayReachable } : {}),
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
