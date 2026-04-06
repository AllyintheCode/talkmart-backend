import axios from 'axios';

const BASE_URL = 'https://talkmart-backend.vercel.app/api';

async function testEndpoints() {
  const endpoints = [
    { name: 'Onboarding', path: '/onboarding' },
    { name: 'Categories', path: '/categories' },
    { name: 'Common Feed (Random/Trend)', path: '/videos/feed' },
    { name: 'Explore (Categories/Search)', path: '/videos/explore' },
    { name: 'Auth Login Check (Existing)', path: '/auth/login', method: 'post' },
    { name: 'Admin Stats Check (Secure)', path: '/admin/dashboard/stats' }
  ];

  console.log('--- TalkMart API Health Check ---');
  
  for (const ep of endpoints) {
    try {
      let response;
      if (ep.method === 'post') {
        response = await axios.post(`${BASE_URL}${ep.path}`, {});
      } else {
        response = await axios.get(`${BASE_URL}${ep.path}`);
      }
      console.log(`✅ ${ep.name} [${ep.path}] -> Status: ${response.status}`);
      if (Array.isArray(response.data)) {
        console.log(`   Count: ${response.data.length} items`);
      }
    } catch (error) {
      if (error.response) {
        if (ep.path.includes('admin') && error.response.status === 401) {
          console.log(`✅ ${ep.name} [${ep.path}] -> Correctly Secured (Unauthenticated 401)`);
        } else if (ep.path.includes('login') && error.response.status === 400) {
          console.log(`✅ ${ep.name} [${ep.path}] -> Active (Bad Request 400 - Expected)`);
        } else {
          console.error(`❌ ${ep.name} [${ep.path}] -> FAILED: Status ${error.response.status}`);
        }
      } else {
        console.error(`❌ ${ep.name} [${ep.path}] -> FAILED: ${error.message}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500)); // Delay for clean output
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
