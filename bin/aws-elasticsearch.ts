#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AwsElasticsearchStack } from "../lib/aws-elasticsearch-stack";

const app = new cdk.App();
new AwsElasticsearchStack(app, "AwsElasticsearchStackSecondThree", {
  env: {
    account: "905417995001",
    region: "us-east-2",
  },
});
