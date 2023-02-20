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
    ar: 0,
    sot: 0,
    worked: 0,
    notInSquad: {
      cse: 0,
      da: 0,
      other: {
        grooming: 0,
        tma: 0,
        dev: 0,
        totalHours: 0,
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
      details.ar += worklog.hours
    }
    else if (is_SOT(worklog)) {
      details.sot += worklog.hours
    }
    else {
      if (await issueIsHisSquad(user.squadName, worklog.issue_key) == false) {
        details.notInSquad.other.totalHours += worklog.hours
        let issue = worklog.issue_key + " " + worklog.issue_summary
        if (is_grooming(worklog)) {
          details.notInSquad.other.grooming += worklog.hours
        }
        else if (is_tma(worklog)) {
          details.notInSquad.other.tma += worklog.hours
        }
        else {
          details.notInSquad.other.dev += worklog.hours
        }
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

function is_SOT(issue) {
  return issue.billing_key == "OVERKIZ-SOT"
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
    ar: 0,
    sot: 0,
    worked: 0,
    notInSquad: {
      cse: 0,
      da: 0,
      other: {
        grooming: 0,
        tma: 0,
        dev: 0,
        totalHours: 0,
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

    squadReport.grooming += report.grooming + report.notInSquad.other.grooming
    squadReport.tma += report.tma + report.notInSquad.other.tma
    squadReport.dev += report.dev + report.notInSquad.other.dev

    squadReport.notInSquad.cse += report.notInSquad.cse
    squadReport.notInSquad.da += report.notInSquad.da
    squadReport.ar += report.ar
    squadReport.sot += report.sot
    squadReport.cp_rtt += report.cp_rtt

    squadReport.notInSquad.other.totalHours += report.notInSquad.other.totalHours
    squadReport.notInSquad.other.grooming += report.notInSquad.other.grooming
    squadReport.notInSquad.other.tma += report.notInSquad.other.tma
    squadReport.notInSquad.other.dev += report.notInSquad.other.dev

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
  console.log(`Worked: ${report.worked}h = ${report.worked/8}j/h`)
  console.log(`CP/RTT: ${report.cp_rtt}h`)
  console.log("======================")
  console.log(`-- Grooming: ${report.grooming}h = ${report.grooming/8}j/h (${((report.grooming / report.worked) * 100).toFixed(2)}%)`)
  console.log(`-- TMA: ${report.tma}h = ${report.tma/8}j/h (${((report.tma / report.worked) * 100).toFixed(2)}%)`)
  console.log(`-- Dev: ${report.dev}h = ${report.dev/8}j/h (${((report.dev / report.worked) * 100).toFixed(2)}%)`)
  console.log(`-- AR: ${report.ar}h = ${report.ar/8}j/h (${((report.ar / report.worked) * 100).toFixed(2)}%)`)
  console.log(`-- SOT: ${report.sot}h = ${report.sot/8}j/h (${((report.sot / report.worked) * 100).toFixed(2)}%)\n`)

  console.log(`Including:`)
  let notInSquad = report.notInSquad.da + report.notInSquad.cse + report.notInSquad.other.totalHours
  console.log(`-- not in squad: ${notInSquad}h (${((notInSquad / report.worked) * 100).toFixed(2)}%)`)
  console.log(`---- DA: ${report.notInSquad.da}h`)
  console.log(`---- CSE: ${report.notInSquad.cse}h`)
  console.log(`---- other: ${report.notInSquad.other.totalHours}h`)
  console.log(`------ Grooming: ${report.notInSquad.other.grooming}h`)
  console.log(`------ TMA: ${report.notInSquad.other.tma}h`)
  console.log(`------ Dev: ${report.notInSquad.other.dev}h`)
  console.log(report.notInSquad.other.arrayOfIssues)
}

async function main() {
  const report = await getSquadReport(config.squad, config.period.sprint_2023_1_4)
  printReport(report)
}

main()