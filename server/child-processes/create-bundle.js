// server/child-processes/create-bundle.js
const { parentPort } = require('worker_threads');
const rollup = require('rollup');
const browserify = require('browserify');
const sander = require('sander');
const { minify } = require('uglify-js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

const tmpDir = path.join(os.tmpdir(), 'packd');

// Создаем временную директорию, если её нет
try {
	if (!fs.existsSync(tmpDir)) {
		fs.mkdirSync(tmpDir, { recursive: true });
	}
} catch (err) {
	console.error('Failed to create temp directory:', err);
}

process.on('message', async (message) => {
	if (message.type === 'start') {
		const { hash, pkg, version, deep, query } = message.params;
		
		try {
			console.log(`[${pkg.name}] Starting bundle creation`);
			
			// Создаем временную директорию для этого пакета
			const packageDir = path.join(tmpDir, hash);
			if (!fs.existsSync(packageDir)) {
				fs.mkdirSync(packageDir, { recursive: true });
			}
			
			// Устанавливаем пакет
			console.log(`[${pkg.name}] Installing ${pkg.name}@${version}`);
			try {
				await exec(`npm install --prefix ${packageDir} --no-package-lock --silent ${pkg.name}@${version}`);
			} catch (installErr) {
				console.error(`[${pkg.name}] Installation failed:`, installErr.message);
				throw new Error(`Failed to install package: ${installErr.message}`);
			}
			
			// Определяем точку входа
			const packageJsonPath = path.join(packageDir, 'node_modules', pkg.name, 'package.json');
			if (!fs.existsSync(packageJsonPath)) {
				throw new Error(`Package.json not found for ${pkg.name}`);
			}
			
			const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
			const entryPoint = packageJson.module || packageJson.main || 'index.js';
			const entryPath = path.join(packageDir, 'node_modules', pkg.name, entryPoint);
			
			if (!fs.existsSync(entryPath)) {
				throw new Error(`Entry point not found: ${entryPoint}`);
			}
			
			let code;
			
			// Выбираем стратегию сборки
			if (query.format === 'esm' && packageJson.module) {
				// Rollup для ESM
				console.log(`[${pkg.name}] Using Rollup for ESM bundle`);
				const bundle = await rollup.rollup({
					input: entryPath,
					external: []
				});
				
				const result = await bundle.generate({
					format: 'esm',
					name: query.name || pkg.name.replace(/[^a-zA-Z0-9_]/g, '_')
				});
				
				code = result.output[0].code;
			} else {
				// Browserify для UMD
				console.log(`[${pkg.name}] Using Browserify for UMD bundle`);
				const b = browserify(entryPath, {
					standalone: query.name || pkg.name.replace(/[^a-zA-Z0-9_]/g, '_'),
					basedir: path.join(packageDir, 'node_modules', pkg.name)
				});
				
				code = await new Promise((resolve, reject) => {
					b.bundle((err, buf) => {
						if (err) reject(err);
						else resolve(buf.toString());
					});
				});
			}
			
			// Минифицируем, если не esm и не запрошено иначе
			if (query.format !== 'esm' && !query.nominify) {
				console.log(`[${pkg.name}] Minifying bundle`);
				try {
					const minified = minify(code);
					if (minified.error) {
						console.warn(`[${pkg.name}] Minification warning:`, minified.error);
					} else {
						code = minified.code;
					}
				} catch (minErr) {
					console.warn(`[${pkg.name}] Minification failed, using unminified:`, minErr.message);
				}
			}
			
			if (!code || code.trim() === '') {
				throw new Error('Generated code is empty');
			}
			
			console.log(`[${pkg.name}] Bundle created successfully, size: ${code.length} bytes`);
			
			// Отправляем результат обратно
			process.send({ type: 'result', code });
			
			// Очищаем временную директорию
			try {
				await exec(`rm -rf ${packageDir}`);
			} catch (cleanErr) {
				console.warn(`Failed to clean up ${packageDir}:`, cleanErr.message);
			}
			
		} catch (err) {
			console.error(`[${pkg.name}] Bundle creation error:`, err.message, err.stack);
			process.send({
				type: 'error',
				message: err.message,
				stack: err.stack
			});
		}
	}
});

// Сообщаем, что процесс готов
process.send('ready');