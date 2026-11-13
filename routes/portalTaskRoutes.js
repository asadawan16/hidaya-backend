import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listTasks, myTaskSummary, getTask, createTask, updateTask, reorderTasks, addTaskComment, deleteTask,
  pickAssignees, pickLeads, listGoals, createGoal, updateGoal, deleteGoal,
  bulkUpdateTasks, undoBulkUpdate, bulkDeleteTasks, restoreTasks, listTaskViews, createTaskView, deleteTaskView,
} from '../controllers/portalTaskController.js'
import { pickAssigneeGroup } from '../controllers/portalTaskGroupController.js'

const router = Router()
router.use(portalAuth)

// Every signed-in user works their own tasks; what else they see is decided
// in the controller (task.create / task.manage). Fixed paths before /:id.
router.get('/', listTasks)
router.get('/my/summary', myTaskSummary)
router.get('/assignees', pickAssignees)
// Anyone who may create tasks (task.create, or task.manage which includes it)
const creators = (req, res, next) => (['task.create', 'task.manage'].some(p => req.userPermissions.has(p)) ? next() : res.status(403).json({ error: 'Insufficient permissions' }))
router.get('/assignees/everyone', creators, pickAssigneeGroup)
router.get('/leads', requirePermission('task.leads'), pickLeads)
router.post('/reorder', reorderTasks)
router.post('/bulk', bulkUpdateTasks)
router.post('/bulk/undo', undoBulkUpdate)
router.post('/bulk/delete', bulkDeleteTasks)
router.post('/restore', restoreTasks)

router.get('/views', listTaskViews)
router.post('/views', createTaskView)
router.delete('/views/:id', deleteTaskView)

router.get('/goals', listGoals)
router.post('/goals', requirePermission('task.manage'), createGoal)
router.patch('/goals/:id', requirePermission('task.manage'), updateGoal)
router.delete('/goals/:id', requirePermission('task.manage'), deleteGoal)

router.post('/', createTask)
router.get('/:id', getTask)
router.patch('/:id', updateTask)
router.post('/:id/comments', addTaskComment)
router.delete('/:id', deleteTask)

export default router
