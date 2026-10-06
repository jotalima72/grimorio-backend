process.env.TEST_POSTGRES = '1';
await import('../test/api.test.js');
