const https = require('https')
const fs = require('fs')
const fetch = require('node-fetch');
const yaml = require('js-yaml');

const { XMLParser } = require('fast-xml-parser');
const { exit } = require('process');
const options = {
  ignoreAttributes: false
};
const xmlParser = new XMLParser(options);

const config = yaml.load(fs.readFileSync('config.yaml', 'utf8'))
const pfx = fs.readFileSync(config.certificate)
const passphrase = config.certificatePaswword
const agent = https.Agent({ pfx, passphrase });
const tempoApiToken = config.tempoApiToken

const baseJiraOvkUrl = config.urlJiraOvk
const baseTempoAPI = "//plugins/servlet/"

async function getIssue(key) {
  // doc: https://docs.atlassian.com/jira-software/REST/7.0.4/#agile/1.0/issue

  const url = "https://jira-external.overkiz.com/rest/agile/1.0/issue/"
  const authorization = Buffer.from(config.jiraAuth.user + ":" + config.jiraAuth.password).toString('base64')
  const response = await fetch(url + key, {
    methode: 'GET',
    agent: agent,
    headers: {
      Authorization: "Basic " + authorization
    },
  })
  exit

  const resp = await response.text();
  console.log(response.status);
  return JSON.parse(resp)
}

function writeInFileToDebug(filename, data) {
  fs.writeFile(filename, data, function (err) {
    if (err) {
      return console.log(err);
    }
    console.log("The file was saved!");
  });
}

async function getWorklogs(userName, dateFrom, dateTo) {
  const config = "&format=xml" + "&addIssueSummary=true" + "&addIssueDetails=true" + "&addParentIssue=true"
  var url = baseJiraOvkUrl + baseTempoAPI + "tempo-getWorklog/" + "?tempoApiToken=" + tempoApiToken + "&userName=" + userName + "&dateFrom=" + dateFrom + "&dateTo=" + dateTo

  const response = await fetch(url + config, {
    methode: 'GET',
    agent: agent
  })

  const resp = await response.text();
  console.log(response.status);
  let jsonObj = xmlParser.parse(resp);

  if (!Array.isArray(jsonObj.worklogs.worklog)) {
    // when api return 1 worklog, ti's not a table
    return [jsonObj.worklogs.worklog]
  }
  return jsonObj.worklogs.worklog
}

async function translateWorklogs(worklogs, user) {
  let details = {
    logged: 0,
    expectedLogged: 0,
    grooming: 0,
    tma: 0,
    dev: 0,
    cp_rtt: 0,
    worked: 0,
    notInSquad: {
      cop: 0,
      cse: 0,
      da: 0,
      ar: 0,
      other: {
        hours: 0,
        arrayOfIssues: []
      }
    }
  }

  for (const worklog of worklogs) {
    details.logged += worklog.hours

    if (is_cpp_rtt(worklog)) {
      details.cp_rtt += worklog.hours
    }
    else if (is_CSE(worklog)) {
      details.notInSquad.cse += worklog.hours
    }
    else if (is_DA(worklog)) {
      details.notInSquad.da += worklog.hours
    }
    else if (is_AR(worklog)) {
      details.notInSquad.ar += worklog.hours
    }
    else {
      if (await issueIsHisSquad(user.squadName, worklog.issue_key) == false) {
        details.notInSquad.other.hours += worklog.hours
        let issue = worklog.issue_key + " " + worklog.issue_summary
        if (!details.notInSquad.other.arrayOfIssues.includes(issue))
          details.notInSquad.other.arrayOfIssues.push(issue)
      }
      else if (is_grooming(worklog)) {
        details.grooming += worklog.hours
      }
      else if (is_tma(worklog)) {
        details.tma += worklog.hours
      }
      else {
        details.dev += worklog.hours
      }
    }
  }
  details.worked = details.logged - details.cp_rtt

  return details
}

function is_CSE(issue) {
  return issue.issue_key == "TEMPO-2"
}

function is_cpp_rtt(issue) {
  return issue.issue_key == "TEMPO-3"
}

function is_DA(issue) {
  return issue.issue_details.project_key == "DA"
}

function is_AR(issue) {
  return issue.issue_details.project_key == "AR"
}

function is_grooming(issue) {
  return issue.issue_details.type_id == 10402
}

function is_tma(issue) {
  return issue.issue_details.type_id == 10102
}

function isInHisSquad(squadName, issue) {
  if (issue.fields.customfield_12624) {
    if (issue.fields.customfield_12624.value == squadName) {
      return true
    }
  }
  return false
}

async function issueIsHisSquad(squadName, key) {
  const issue = await getIssue(key)
  return isInHisSquad(squadName, issue)
}

async function getUserReport(user, period) {

  const dateFrom = period.start
  const dateTo = period.end
  const nbDays = period.nbDays

  console.log(`get user report of ${user.id}...`)
  const worklogs = await getWorklogs(user.id, dateFrom, dateTo)
  const userReport = await translateWorklogs(worklogs, user)
  userReport.expectedLogged = nbDays * user.hoursPerDay
  console.log("Done")
  return userReport
}


async function getSquadReport(squad, period) {
  let squadReport = {
    logged: 0,
    expectedLogged: 0,
    grooming: 0,
    tma: 0,
    dev: 0,
    cp_rtt: 0,
    worked: 0,
    notInSquad: {
      cop: 0,
      cse: 0,
      da: 0,
      ar: 0,
      other: {
        hours: 0,
        arrayOfIssues: []
      }
    }
  }

  for (const user of squad.members) {
    user.member.squadName = squad.name
    const report = await getUserReport(user.member, period)

    squadReport.logged += report.logged
    squadReport.worked += report.worked
    squadReport.expectedLogged += report.expectedLogged

    squadReport.grooming += report.grooming
    squadReport.tma += report.tma
    squadReport.dev += report.dev

    squadReport.notInSquad.cop += report.notInSquad.cop
    squadReport.notInSquad.cse += report.notInSquad.cse
    squadReport.notInSquad.da += report.notInSquad.da
    squadReport.notInSquad.ar += report.notInSquad.ar
    squadReport.cp_rtt += report.cp_rtt

    squadReport.notInSquad.other.hours += report.notInSquad.other.hours

    if (report.notInSquad.other.arrayOfIssues.length) {
      for (const issue of report.notInSquad.other.arrayOfIssues) {
        if (!squadReport.notInSquad.other.arrayOfIssues.includes(issue))
          squadReport.notInSquad.other.arrayOfIssues.push(issue)
      }
    }
  }
  return squadReport
}

function printReport(report) {
  let completed = ((report.logged / report.expectedLogged) * 100).toFixed(2)
  let missingHours = report.expectedLogged - report.logged

  console.log("======================")
  console.log(`Worklog report`)
  console.log(`Completed at ${completed}%, ${report.logged}h (missing ${missingHours}h)`)
  console.log("======================")

  console.log(`-- CP/RTT: ${report.cp_rtt}h`)
  console.log(`-- Grooming: ${report.grooming}h (${((report.grooming / report.worked) * 100).toFixed(2)}%)`)
  console.log(`-- TMA: ${report.tma}h (${((report.tma / report.worked) * 100).toFixed(2)}%)`)
  console.log(`-- Dev: ${report.dev}h (${((report.dev / report.worked) * 100).toFixed(2)}%)`)

  let notInSquad = report.notInSquad.da + report.notInSquad.ar + report.notInSquad.cse + report.notInSquad.other.hours
  console.log(`-- not in squad: ${notInSquad}h (${((notInSquad / report.worked) * 100).toFixed(2)}%)\n`)

  console.log(`---- DA: ${report.notInSquad.da}h`)
  console.log(`---- AR: ${report.notInSquad.ar}h`)
  console.log(`---- CSE: ${report.notInSquad.cse}h`)
  console.log(`---- CoP: ${report.notInSquad.cop}h`)
  console.log(`---- other: ${report.notInSquad.other.hours}h`)
  console.log(report.notInSquad.other.arrayOfIssues)
}

async function main() {
  const report = await getSquadReport(config.squad, config.period.sprint_2023_1_1)
  printReport(report)
}

main()