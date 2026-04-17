'use strict';

const { execSync } = require('child_process');
const path = require('path');

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');

function startServices() {
  execSync(`docker compose -f ${COMPOSE_FILE} up -d --wait`, { stdio: 'inherit' });
}

function stopServices() {
  execSync(`docker compose -f ${COMPOSE_FILE} down -v`, { stdio: 'inherit' });
}

module.exports = { startServices, stopServices };
