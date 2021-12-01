import express from 'express';
import fs from 'fs';
const { NodeSSH } = require('node-ssh');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5122;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.listen(port, () => console.log(`Listening on port ${port}`));

const user = process.env.sshUsername;
const pathCompile = `/home/${user}/compile/`;

// https://www.marksei.com/lxc-getting-started-linux-containers/
// https://linuxcontainers.org/lxc/getting-started/ LXC create
// https://serverok.in/lxc-error-unable-to-fetch-gpg-key-from-keyserver fix LXC create
// https://bobcares.com/blog/ssh-to-lxc-containers/ SSH into LXC
// https://ubuntuforums.org/showthread.php?t=1384034 install openssh server on LXC
// https://phoenixnap.com/kb/how-to-list-users-linux https://tekneed.com/create-users-in-linux-password-manage-user-expiration/ https://linuxhint.com/give-user-folder-permission-linux/ create lxcuser
// https://upcloud.com/community/tutorials/use-ssh-keys-authentication/ https://aapjeisbaas.nl/post/push-ssh-public-key-to-lxc-container/ generate and use key
// https://askubuntu.com/questions/307881/ssh-public-key-authentication-doesnt-work setup sshd_config properly
// mkdir compile chown albert:albert chmod 700
// https://www.cyberciti.biz/faq/howto-compile-and-run-c-cplusplus-code-in-linux/ install gcc
// https://superuser.com/questions/433988/how-to-find-the-ip-address-of-a-vm-running-on-vmware-or-other-methods-of-using/531635 find VMware IP

const ssh = new NodeSSH();
let sshConnected = false;

const connectSsh = async (): Promise<void> => {
  await ssh.connect({
    host: process.env.sshAddress,
    username: user,
    privateKey: process.env.sshPrivateKeyLocation,
  });

  sshConnected = true;
};

const sourceFolderPath = 'received_sources';

if (!fs.existsSync(`${sourceFolderPath}/`)) {
  fs.mkdirSync(sourceFolderPath);
}

interface CodeCompileAndRunRequest {
  code: string;
  expectedResults: string[];
  testData?: string[];
}

interface ExecutionOutput {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecutionResult extends ExecutionOutput {
  outputMatchesExpectation?: boolean;
  args?: string;
}

const compile = async ({
  code,
  expectedResults,
  testData,
}: CodeCompileAndRunRequest): Promise<ExecutionResult[]> => {
  if (!sshConnected) {
    await connectSsh();
  }

  // Create path variables and temporary source code file to upload
  const runName = new Date().getTime();
  const pathLocalSource = `${sourceFolderPath}/${runName}.c`;

  fs.writeFileSync(pathLocalSource, code);

  const pathRemote = `${pathCompile}${runName}/`;
  const pathRemoteSource = `${pathRemote}${runName}.c`;
  const pathRemoteExecutable = `${pathRemote}${runName}`;

  let compileResult: ExecutionResult;
  const runResults: ExecutionResult[] = [];

  try {
    // Create target folder and copy source code file
    await ssh.mkdir(pathRemote);
    await ssh.putFile(pathLocalSource, pathRemoteSource);

    // Compile source code
    compileResult = (await ssh.execCommand(
      `gcc ${pathRemoteSource} -o ${pathRemoteExecutable}`
    )) as ExecutionOutput;
    const compileSuccess = compileResult.code === 0;

    
    if (!compileSuccess) {
      // If the compile failed, return its output instead
      return [compileResult];
    }

    if (Array.isArray(testData)) {
      // If there's test data, run the program with each data element as the run arguments
      // for (const data of testData) {
      testData.forEach(async (data, index) => {
        const execOutput = (await ssh.execCommand(
          `${pathRemoteExecutable} ${data}`
        )) as ExecutionOutput;
        // Save the output, appending whether the output matches the expectation and our test data as args
        runResults.push({ ...execOutput, outputMatchesExpectation: execOutput.stdout === expectedResults[index], args: data});
      });
    } else {
      // When there's no test data, just run a single time without arguments and return the execution output
      runResults.push(
        (await ssh.execCommand(pathRemoteExecutable)) as ExecutionOutput
      );
    }

    return runResults;
  } catch (e) {
    throw e;
  } finally {
    await ssh.execCommand(`rm -rd ${pathRemote}`);
    fs.rmSync(pathLocalSource);
  }
};

app.post('/compile-and-run', async (req, res) => {
  try {
    const request = req.body as CodeCompileAndRunRequest;
    const results = await compile(request);

    if (results.every((result) => result.code === 0)) {
      res.status(200).send(results);
    } else {
      res.status(400).send(results);
    }
  } catch (e) {
    res.status(500).send(e);
  }
});

process.on('SIGINT', () => {
  console.log('\nCtrl+C detected, shutting down server...');
  ssh.dispose();
  console.log('SSH connection closed successfully. Quitting.');
  process.exit();
});
