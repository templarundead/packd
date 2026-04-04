const { fork } = require('child_process');
const sander = require('sander');
const semver = require('semver');
const zlib = require('zlib');
const fs = require('fs');
const get = require('./utils/get.js');
const findVersion = require('./utils/findVersion.js');
const logger = require('./logger.js');
const cache = require('./cache.js');
const etag = require('etag');
const sha1 = require('sha1');
const { sendBadRequest, sendError } = require('./utils/responses.js');
const { root, registry, additionalBundleResHeaders } = require('../config.js');
// Функция для форматирования байтов
function formatBytes(bytes) {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function stringify(query) {
	const str = Object.keys(query).sort().map(key => `${key}=${query[key]}`).join('&');
	return str ? `?${str}` : '';
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;')
        .replace(/\//g, '&#47;');
}
module.exports = function servePackage(req, res, next) {
	if (req.method !== 'GET') return next();
	const match = /^\/(?:@([^\/]+)\/)?([^@\/]+)(?:@(.+?))?(?:\/(.+?))?(?:\?(.+))?$/.exec(req.url);
	if (!match) {
		return sendBadRequest(res, 'Invalid module ID');
	}
	const user = match[1];
	const id = match[2];
	const tag = match[3] || 'latest';
	const deep = match[4];
	const queryString = match[5];
	const qualified = user ? `@${user}/${id}` : id;
	const query = (queryString || '').split('&').reduce((query, pair) => {
		if (!pair) return query;
		const [key, value] = pair.split('=');
		query[key] = value || true;
		return query;
	}, {});
	if (query.format && (query.format !== 'umd' && query.format !== 'esm')) {
		return sendBadRequest(res, 'Invalid format (must be umd or esm)');
	}
	get(`${registry}/${encodeURIComponent(qualified).replace('%40', '@')}`).then(JSON.parse).then(meta => {
		if (!meta.versions) {
			logger.error(`[${qualified}] invalid module`);
			return sendBadRequest(res, 'invalid module');
		}
		const version = findVersion(meta, tag);
		if (!semver.valid(version)) {
			logger.error(`[${qualified}] invalid tag`);
			return sendBadRequest(res, 'invalid tag');
		}
		if (version !== tag) {
			let url = `/${meta.name}@${version}`;
			if (deep) url += `/${deep}`;
			url += stringify(query);
			res.redirect(302, url);
			return;
		}
		return fetchBundle(meta, tag, deep, query).then(zipped => {
			logger.info(`[${qualified}] serving ${zipped.length} bytes`);
			// Если запрошен raw JS
			if (query.raw === 'true') {
				res.status(200);
				res.set(Object.assign({
					'Content-Length': zipped.length,
					'Content-Type': 'application/javascript; charset=utf-8',
					'Content-Encoding': 'gzip'
				}, additionalBundleResHeaders));
				res.setHeader('ETag', etag(zipped));
				res.end(zipped);
			} else {
				// Показываем HTML с кнопкой
// Показываем HTML с кнопкой
// Показываем HTML с кнопкой
try {
    const bundleContent = zlib.gunzipSync(zipped).toString('utf-8');
    const gzippedSize = formatBytes(zipped.length);
    const originalSize = formatBytes(Buffer.byteLength(bundleContent, 'utf-8'));
    const sizeLabel = `${originalSize} (${gzippedSize} gzipped)`;
    const packageDisplay = qualified + (tag !== 'latest' ? `@${tag}` : '');
    
    const templatePath = `${root}/server/templates/bundle.html`;
    let template = fs.readFileSync(templatePath, 'utf-8');
    
// Вместо прямой вставки, используем JSON.stringify для экранирования
const html = template
    .replace(/__PACKAGE_NAME__/g, escapeHtml(packageDisplay))
    .replace('__PACKAGE_SIZE__', escapeHtml(sizeLabel))
    .replace('__BUNDLE_CONTENT_PLACEHOLDER__', JSON.stringify(bundleContent));
    res.status(200);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
} catch (err) {
    logger.error(`[${qualified}] Failed to render HTML: ${err.message}`);
    // Fallback на raw JS
    res.status(200);
    res.set(
        Object.assign(
            {
                'Content-Length': zipped.length,
                'Content-Type': 'application/javascript; charset=utf-8',
                'Content-Encoding': 'gzip'
            },
            additionalBundleResHeaders
        )
    );
    res.setHeader('ETag', etag(zipped));
    res.end(zipped);
}
			}
		});
	}).catch(err => {
		logger.error(`[${qualified}] ${err.message}`, err.stack);
		const page = sander.readFileSync(`${root}/server/templates/500.html`, {
			encoding: 'utf-8'
		}).replace('__ERROR__', err.message);
		sendError(res, page);
	});
};
const inProgress = {};

function fetchBundle(pkg, version, deep, query) {
	let hash = `${pkg.name}@${version}`;
	if (deep) hash += `_${deep.replace(/\//g, '_')}`;
	hash += stringify(query);
	logger.info(`[${pkg.name}] requested package`);
	hash = sha1(hash);
	if (cache.has(hash)) {
		logger.info(`[${pkg.name}] is cached`);
		return Promise.resolve(cache.get(hash));
	}
	if (inProgress[hash]) {
		logger.info(`[${pkg.name}] request was already in progress`);
	} else {
		logger.info(`[${pkg.name}] is not cached`);
		inProgress[hash] = createBundle(hash, pkg, version, deep, query).then(result => {
			const zipped = zlib.gzipSync(result);
			cache.set(hash, zipped);
			return zipped;
		}, err => {
			inProgress[hash] = null;
			throw err;
		}).then(zipped => {
			inProgress[hash] = null;
			return zipped;
		});
	}
	return inProgress[hash];
}

function createBundle(hash, pkg, version, deep, query) {
	return new Promise((fulfil, reject) => {
		const child = fork('server/child-processes/create-bundle.js');
		child.on('message', message => {
			if (message === 'ready') {
				child.send({
					type: 'start',
					params: { hash, pkg, version, deep, query }
				});
			}
			if (message.type === 'info') {
				logger.info(message.message);
			} else if (message.type === 'error') {
				const error = new Error(message.message);
				error.stack = message.stack;
				reject(error);
				child.kill();
			} else if (message.type === 'result') {
				fulfil(message.code);
				child.kill();
			}
		});
	});
}
