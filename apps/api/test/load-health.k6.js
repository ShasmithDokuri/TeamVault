import http from 'k6/http';
import { check } from 'k6';

const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/u, '');

export const options = {
  scenarios: {
    health_smoke: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 2,
      maxVUs: 10,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  for (const path of ['/api/health', '/api/ready']) {
    const response = http.get(`${baseUrl}${path}`, { tags: { endpoint: path } });
    check(response, { [`${path} responds successfully`]: (result) => result.status === 200 });
  }
}
