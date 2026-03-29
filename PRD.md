# HITL (Human-in-the-Loop)

A HITL agentic development orchestrator.

## The Goal

This repo will be a tool for humans (developers) to "react" to an automated agentic development flow. Azure work item progress becomes stateful and awaits human review at every step.

## Why HITL

GitHub Copilot technically is becoming a HITL orchestration tool but our current infrastructure constrains us from leveraging everything GitHub has to offer. Copilot cloud agents are expensive and they aren't easily integrated with our Azure pipelines and taskboard system.

## How It Works

The end to end workflow will be driven by a cron job:

### Cron Job

1. This will run every minute.
2. This will run an azure query to get all the human's stories in the current sprint that have "active" and/or "new" tasks in them, even if the story is closed. Then upsert them into a database.
3. This will also execute different steps depending on the state of each item in the grids below.
4. The cron job should use `powerMonitor.getSystemIdleState(FIFTEEN_MIN)` to prevent the job from continuing while the computer is idle.

#### The Grids

- There will be 4 grids on the page:
   1. "Profile Assignment"
   2. "Plan Approval"
   3. "Task PR Review"
   4. "Story PR Review"
   5. "Completed"
- Each grid represents a state in the development loop where a human is required to act in order for the grid item to move to the next grid.
- Items in each grid will be in a disabled state when an agent is actively working on that item or if they are completed. 

##### Profile Assignment

- The columns in this grid are:
  1. Story Id - this will also be a link that opens the azure item.
  2. Story Title
  3. Profile - there will be a profile.json file that contains a configuration for different repos. This will give the agent context on where (repo path) to perform their tasks. This is a dropdown that displays the top level keys in profile.json. 
- Selecting a profile will indicate to the cron job script that it is ready for an agent to go plan the story which moves it to the Plan Approval grid.
- If a profile is selected, the cron job script will find an idle git worktree or create a new worktree if all worktrees for the repo are in use. It will then checkout a new story branch `story/<work-item-id>` for the agent to work in.
- There is no disabled state for this grid.

##### Plan Approval

- The columns in this grid are:
  1. Story Id - this will also be a link that opens the azure item.
  2. Story Title
  3. Worktree - this is a link to open vscode at the worktree the agent is planning in.
  4. Session - this is a link to the copilot cli session id. clicking on it will open a windows terminal window and open the session.
  5. Workspace - this is a link that creates a virtual desktop, opens vscode, opens the copilot cli session in windows terminal, and opens the task in azure for you. This allows the human to work more directly on the plan.
- When the agent is planning, it will come up with a plan to create the acceptance criteria as well as for all the tasks needed in order to complete the story.
- A hook will need to be set up on the human's machine in order to know if a session is idle or not. When copilot cli fires a `session.idle` event, it will indicate to this grid that it is waiting for human approval, otherwise the grid item is disabled.
- Another hook will need to be set up to listen for any other event fired after `session.idle` to indicate that the user interacted with the plan. If approved, the azure story should be updated with the acceptance criteria, the tasks for the story should be created, and the story grid item will be moved to the Task PR Review grid in a disabled state (agent will be working on the tasks). If not approved, the grid item will become disabled again and wait for the `session.idle` event.
- Once the plan is approved, the agent will find idle git worktrees or create a new worktrees if all worktrees for the repo are in use, to work on each task (using a subagent?). Each task will be worked on in a new branch `task/<work-item-id>` and once completed will create a PR to be merged into the `story/<work-item-id>` branch.

##### Task PR Review

- The columns in this grid are:
  1. Story Id - this will also be a link that opens the azure item. Tasks associated with the story id will be grouped by Story Id
  2. Task Completed - this will be a checkbox that shows if a task's PR has been merged or not.
  3. Task Id - this will also be a link that opens the azure item.
  4. Task Title
  5. Worktree - this is a link to open vscode at the worktree the agent is planning in.
  6. Session - this is a link to the copilot cli session id. clicking on it will open a windows terminal window and open the session.
  7. Workspace - this is a link that creates a virtual desktop, opens vscode, opens the copilot cli session in windows terminal, and opens the task in azure and pull request in github for you. This allows the human to work more directly on the task.
  8. Pull Request - this is a link to task pull request on GitHub.
- A GitHub webhook will need to be set up to handle updates to for all created pull requests. When the pull request is updated, it will update the database for the associated item to indicate to the cron job script that it needs to check GitHub for updates.
- The cron job will also use the `session.idle` event to check if the session is waiting on human interaction. The disabled state will behave the same way as the Plan Approval grid. If the session is idle, the cron job will wait for certain state changes on the pull request:
  - The cron job will check if the PR has new unresolved comments (if the GH webhook updated the item saying that the PR was updated). If so, it will prompt the copilot cli session with those comments and their context so the agent can respond with an update.
  - The cron job will check if the PR has been merged (if the GH webhook updated the item saying that the PR was updated). If so, the task grid item will be checked and be disabled
  - The cron job will check if all tasks are checked. If so, the story grid item will be moved to the Story PR Review grid. 

##### Story PR Review

- The columns in this grid are:
  1. Story Id - this will also be a link that opens the azure item.
  2. Story Title
  3. Worktree - this is a link to open vscode at the worktree the agent is planning in.
  4. Session - this is a link to the copilot cli session id. clicking on it will open a windows terminal window and open the session.
  7. Workspace - this is a link that creates a virtual desktop, opens vscode, opens the copilot cli session in windows terminal, and opens the task in azure and pull request in github for you. This allows the human to work more directly on the task.
  5. Pull Request - this is a link to relevant pull request on GitHub.
- The cron job will also use the `session.idle` event to check if the session is waiting on human interaction. The disabled state will behave the same way as the Plan Approval grid. If the session is idle, the cron job will wait for certain state changes on the pull request:
  - The cron job will check if the PR has new unresolved comments (if the GH webhook updated the item saying that the PR was updated). If so, it will prompt the copilot cli session with those comments and their context so the agent can respond with an update. The agent will make the changes on the story branch.
  - The cron job will check if the PR has been merged (if the GH webhook updated the item saying that the PR was updated). If so, the grid item will be marked complete in the database and moved to the Completed grid.

##### Completed

- The columns in this grid are:
  1. Id (work item id) - this will also be a link that opens the azure item.
  2. Title (work item title)
  3. Session - this is a link to the copilot cli session id. clicking on it will open a windows terminal window and open the session.
  4. Pull Request - this is a link to relevant pull request on GitHub.
- All items in this grid are in a disabled state
- This grid serves as a record history of what has been accomplished.
- If a new task or bug is created after completion, this story will be marked incomplete and run through all grid states again.

## Notes

- Every step of the cron job should be behind a flag indicating that it can execute that portion of the script. We don't want the job to be calling a cli every minute for example.
- The style for the display should use the catppuccin theme and should have a minimalistic display. 