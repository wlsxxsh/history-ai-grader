const db = require('../server/src/db');
const { buildOrdinarySectionContext } = require('../server/src/subjectiveReviewUtils');

function sumScore(items) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + Number(item?.score || 0), 0);
}

function formatIssue(issue) {
  return [
    `${issue.task} | ${issue.student} | Q${issue.questionNo}`,
    `earned=${issue.earnedScore}`,
    `point=${issue.pointScore}`,
    `match=${issue.matchScore}`,
    `reasons=${issue.reasons.join(',')}`,
  ].join(' | ');
}

function pushSingleLateMarkerRegressionIssues(issues) {
  const targetTask = db.listTasks().find((task) => String(task.name || '').trim() === 'test-1');
  if (!targetTask) return;

  const detail = db.getTaskDetail(targetTask.id);
  const targetStudentName = '\u4efb\u6021\u8431';
  const targetQuestionNo = '61';
  const student = (detail?.studentRecords || []).find((item) => item.studentName === targetStudentName);
  const question = (detail?.questions || []).find((item) => String(item.questionNo) === targetQuestionNo);
  const summary = (detail?.subjectiveGrading?.studentSummaries || []).find((item) => item.studentName === targetStudentName);
  const grade = (summary?.questionGrades || []).find((item) => String(item.questionNo) === targetQuestionNo);
  const answer = (student?.subjectiveAnswers || []).find((item) => String(item.questionNo) === targetQuestionNo)?.content || '';

  if (!student || !question || !grade || !answer) return;

  const context = buildOrdinarySectionContext({ question, answer });
  if (
    !context.hasReliableAnswerMarkers
    || context.answerSections.length !== 2
    || context.answerSections[0]?.order !== 1
    || context.answerSections[1]?.order !== 2
  ) {
    issues.push({
      task: detail.name || targetTask.name || targetTask.id,
      student: targetStudentName,
      questionNo: targetQuestionNo,
      earnedScore: Number(grade.earnedScore || 0),
      pointScore: sumScore(grade.pointReviews || []),
      matchScore: sumScore((grade.annotationRanges || []).filter((item) => item?.tone === 'match')),
      reasons: ['single_late_marker_split_failed'],
    });
  }

  const misplacedFirstSubquestionPoints = (grade.pointReviews || []).filter(
    (item) =>
      String(item?.sectionKey || '') === 'ordinary-2'
      && (Array.isArray(item?.matchedExcerpts) ? item.matchedExcerpts : []).some((excerpt) =>
        String(excerpt || '').includes('\u5f81\u6536\u8d4b\u5f79'),
      ),
  );
  if (misplacedFirstSubquestionPoints.length) {
    issues.push({
      task: detail.name || targetTask.name || targetTask.id,
      student: targetStudentName,
      questionNo: targetQuestionNo,
      earnedScore: Number(grade.earnedScore || 0),
      pointScore: sumScore(grade.pointReviews || []),
      matchScore: sumScore((grade.annotationRanges || []).filter((item) => item?.tone === 'match')),
      reasons: ['single_late_marker_points_misplaced'],
    });
  }
}

const issues = [];
let ordinaryGradeCount = 0;

for (const task of db.listTasks()) {
  const detail = db.getTaskDetail(task.id);
  const studentSummaries = detail?.subjectiveGrading?.studentSummaries || [];

  for (const student of studentSummaries) {
    for (const grade of student.questionGrades || []) {
      if (String(grade?.questionType || '') === 'essay') {
        continue;
      }

      ordinaryGradeCount += 1;

      const pointReviews = Array.isArray(grade.pointReviews) ? grade.pointReviews : [];
      const annotationRanges = Array.isArray(grade.annotationRanges) ? grade.annotationRanges : [];
      const matchRanges = annotationRanges.filter((item) => item?.tone === 'match');
      const reasons = [];

      const earnedScore = Number(grade.earnedScore || 0);
      const pointScore = sumScore(pointReviews);
      const matchScore = sumScore(matchRanges);
      const positiveWithoutExcerpt = pointReviews.filter(
        (item) => Number(item?.score || 0) > 0 && !(Array.isArray(item?.matchedExcerpts) && item.matchedExcerpts.length),
      );

      if (Math.abs(earnedScore - pointScore) > 0.01) {
        reasons.push('earned!=point');
      }
      if (Math.abs(pointScore - matchScore) > 0.01) {
        reasons.push('point!=match');
      }
      if (earnedScore > 0 && matchRanges.length === 0) {
        reasons.push('score_without_match');
      }
      if (positiveWithoutExcerpt.length > 0) {
        reasons.push('positive_without_excerpt');
      }

      if (reasons.length > 0) {
        issues.push({
          task: detail.name || task.name || task.id,
          student: student.studentName || student.studentId || 'unknown',
          questionNo: grade.questionNo || '?',
          earnedScore,
          pointScore,
          matchScore,
          reasons,
        });
      }
    }
  }
}

pushSingleLateMarkerRegressionIssues(issues);

if (!ordinaryGradeCount) {
  console.log('No graded ordinary subjective questions found.');
  process.exit(0);
}

if (issues.length) {
  console.error(`Ordinary subjective regression check failed. grades=${ordinaryGradeCount} issues=${issues.length}`);
  issues.forEach((issue) => console.error(formatIssue(issue)));
  process.exit(1);
}

console.log(`Ordinary subjective regression check passed. grades=${ordinaryGradeCount}`);
