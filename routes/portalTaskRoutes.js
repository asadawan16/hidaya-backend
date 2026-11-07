import { Router } from 'express'
import { portalAuth, requirePermission } from '../middleware/portalAuth.js'
import {
  listTasks, myTaskSummary, getTask, createTask, updateTask, reorderTasks, addTaskComment, deleteTask,
  pickAssignees, pickLeads, listGoals, createGoal, updateGoal, deleteGoal,
  bulkUpdateTasks, undoBulkUpdate, bulkDeleteTasks, restoreTasks, listTaskViews, createTaskView, deleteTaskView,
} from '../controllers/portalTaskController.js'

const router = Router()
router.use(portalAuth)

// Every signed-in user works their own tasks; what else they see is decided
// in the controller (task.read / task.manage). Fixed paths before /:id.
router.get('/', listTasks)
router.get('/my/summary', myTaskSummary)
router.get('/assignees', pickAssignees)
router.get('/leads', requirePermission('student.create'), pickLeads)
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
