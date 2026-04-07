# E2E Main Development Flow

1. A story is assigned to me with a good description of what I need to accomplish.
   1. In a new grid "Story Planning", a row is displayed indicating to me that I need to plan that story.
      1. Columns:
         1. "Status" - no header
         2. "Story Id"
         3. "Story Title"
         4. "IDE" - Path to the main repo (not a git worktree repo). Planning will be done on the main branch.
         5. "Done" - no header. This is a button that when clicked:
            1. Closes the IDE if open
            2. Removes the grid item from the Story Planning Grid
2. I use a STORY agent
   1. Agent reads the azure story
   2. Agent reads the repo and plans development
   3. Agent breaks the story into tasks
   4. Agent creates the tasks in azure.
3. I click a button on the Story Planning grid item that indicates that I'm done planning.
   1. The grid item is hidden forever since tasks have been created and will show up in Profile Assignment
4. I assign a profile and click execute
   1. The grid item gets moved to the new grid "Copilot Kickoff". This shows the active indicator
      1. Columns:
         1. "Status" - no header
         2. "Task Id"
         3. "Task Title"
         4. "Session" - displays an indicator showing that copilot is in progress.
         5. "Worktree" - the name of the worktree the session is working in.
5. A copilot session kicks off and executes the task in a new/reuseable git worktree.
   1. Upon completion, a hook will fire and the grid item will be moved to Task Execution.
6. I click on "Open" in Virtual Destop column in the Task Execution grid to work on the item.
   1. Task Execution will now show enabled grid items when a Virtual Desktop is not opened and disabled items if a Virtual Desktop is opened.
   2. Task Execution will no longer have a Draft PR column.
   3. Task Execution will now be sorted by last agent response. When an agent becomes idle, a hook should fire and update a last agent response value that is used to sort which items have needed attention from me the longest with the longest being at the top of the grid.
      1. Virtual Desktops will also be sorted in the same way. Therefore, the Task Execution grid should reflect the order that the Virtual Desktops are in.
   4. Clicking open the first time is now what triggers the azure work item to be set to "Active".
7. I use a TASK agent
   1. Agent reads the azure task (gets the work item number from the git branch)
   2. Agent evaluates the changes the copilot kickoff session made.
   3. Agent makes changes if needed
   4. Once successfully executed, the agent indicates that it is done.
   5. Agent does not validate changes, use git to add, commit, or push changes, and doesn't create a PR.
8. I use a VALIDATE agent
   1. Agent reads git changes on the branch
   2. Agent runs commands to ensure full coverage for changes made.
   3. If there are validation error, the agent outputs something for me to copy so I can prompt the TASK agent to fix it.
   4. Once successfully validated, the agent indicates that it is done.
   5. Agent does not use git to add, commit, or push changes, and doesn't create a PR.
9. I use a PR agent
10. Agent reads git changes on the branch
11. Agent writes a title and concise description based on the git changes
12. Agent stages changes (if necessary)
13. Agent writes a short commit message and commits the staged changes
14. Agent creates a PR with gh cli
15. A PR is created and the grid item is moved to PR Review and the associated Virtual Desktop and all of its windows are closed.
16. The PR is merged and the grid item is moved to Completed
