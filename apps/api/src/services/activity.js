const activityRepository = require('../activity/repository');

function createActivityService(repository = activityRepository) {
  return Object.freeze({
    listActivityForMember: (input) => repository.listActivityForMember(input),
    recordActivityInTransaction: (client, input) => repository.recordActivity(client, input),
  });
}

module.exports = { createActivityService };
