import axios from 'axios';

const BASE_URL = 'https://talkmart-backend.vercel.app/api';

async function testEndpoints() {
  const endpoints = [
    { name: 'Onboarding', path: '/onboarding' },
    { name: 'Categories', path: '/categories' },
    { name: 'Common Feed (Random/Trend)', path: '/videos/feed' },
    { name: 'Explore (Categories/Search)', path: '/videos/explore' }
  ];

  console.log('--- TalkMart API Health Check ---');
  
  for (const ep of endpoints) {
    try {
      const response = await axios.get(`${BASE_URL}${ep.path}`);
      console.log(`✅ ${ep.name} [${ep.path}] -> Status: ${response.status}`);
      if (Array.isArray(response.data)) {
        console.log(`   Count: ${response.data.length} items`);
      }
    } catch (error) {
      console.error(`❌ ${ep.name} [${ep.path}] -> FAILED: ${error.message}`);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
      }
    }
  }

  // Swagger UI Check
  try {
    const swaggerResponse = await axios.get('https://talkmart-backend.vercel.app/api-docs/');
    console.log(`✅ Swagger UI [/api-docs/] -> Status: ${swaggerResponse.status}`);
  } catch (error) {
    console.error(`❌ Swagger UI [/api-docs/] -> FAILED: ${error.message}`);
  }

  console.log('---------------------------------');
}

testEndpoints();
