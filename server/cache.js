const { LRUCache } = require('lru-cache');

module.exports = new LRUCache({
  max: 134217728,
  length: (src) => src.length
});
