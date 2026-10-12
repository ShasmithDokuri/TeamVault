const projectRepository = require('../projects/repository');

function createProjectService(repository = projectRepository) {
  return Object.freeze({
    createProject: (input) => repository.createProject(input),
    createTask: (input) => repository.createTask(input),
    deleteProjectForManager: (input) => repository.deleteProjectForManager(input),
    deleteTaskForManager: (input) => repository.deleteTaskForManager(input),
    getProjectForMember: (input) => repository.getProjectForMember(input),
    getTaskForMember: (input) => repository.getTaskForMember(input),
    listProjectsForMember: (input) => repository.listProjectsForMember(input),
    listTasksForMember: (input) => repository.listTasksForMember(input),
    updateProjectForManager: (input) => repository.updateProjectForManager(input),
    updateTaskForMember: (input) => repository.updateTaskForMember(input),
  });
}

module.exports = { createProjectService };
